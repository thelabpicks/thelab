"""The Lab's daily upkeep, run by the "Daily report and health check" workflow with no one at the keyboard.

1. Posts today's daily model report (written by the publish run to lab/reports/ on the nfl-data branch) as a comment
   on the "Daily model report" issue, mentioning the owner so GitHub sends it by email and to the GitHub app.
2. Checks that every part of the site is still running: each data workflow succeeded recently, The Lab's picks and
   today's report were written, the site answers, the odds key works. Problems go on one "The Lab needs attention"
   issue (opened, updated when the list changes, closed with an all-clear when everything is back).

Needs: git with origin/nfl-data and origin/nba-data fetched, the GitHub CLI (gh) with GH_TOKEN, GITHUB_REPOSITORY.
Nothing here changes the site or the picks.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

REPO = os.environ["GITHUB_REPOSITORY"]
OWNER = os.environ.get("LAB_OWNER") or REPO.split("/")[0]
REPORT_TITLE = "Daily model report"
ALERT_TITLE = "The Lab needs attention"
# A workflow whose last success is older than this is flagged (each one runs at least daily).
STALE_HOURS = {"nba-collect.yml": 30, "cfb-collect.yml": 30, "publish-site.yml": 30}
NAMES = {"nba-collect.yml": "Collect NBA data", "cfb-collect.yml": "Collect college football data",
         "publish-site.yml": "Refresh data and publish site"}


def sh(*args: str, check: bool = True) -> str:
    r = subprocess.run(args, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"{' '.join(args[:3])}: {r.stderr.strip()[:300]}")
    return r.stdout


def gh_json(*args: str):
    out = sh("gh", *args)
    return json.loads(out) if out.strip() else None


def git_show(ref_path: str) -> str | None:
    r = subprocess.run(["git", "show", ref_path], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def actions_url(wf: str) -> str:
    return f"https://github.com/{REPO}/actions/workflows/{wf}"


# --------------------------------------------------------------------------- report

def report_markdown(text: str) -> str:
    """The plain-text report as GitHub markdown: title, sport headings, sub-headings and bullets kept as they read."""
    lines = text.rstrip().splitlines()
    out = []
    for i, line in enumerate(lines):
        s = line.strip()
        if not s:
            out.append("")
            continue
        indent = len(line) - len(line.lstrip())
        nxt = next((x for x in lines[i + 1:] if x.strip()), "")
        deeper = len(nxt) - len(nxt.lstrip()) > indent
        if i == 0:
            out.append(f"### {s}")
        elif s.startswith("- "):
            out.append(s)
        elif indent == 0 and (s.endswith(":") or (deeper and len(s) <= 5)):
            out += ["", f"**{s}**"]
        elif indent and deeper:
            out += ["", f"*{s}*"]
        elif indent:
            out.append(f"- {s}")
        else:
            out += ["", s]
    return "\n".join(out)


def find_issue(title: str, state: str = "all") -> dict | None:
    rows = gh_json("issue", "list", "-R", REPO, "--state", state, "--limit", "200", "--json", "number,title,state,body") or []
    rows = [r for r in rows if r["title"] == title]
    rows.sort(key=lambda r: (r["state"] != "OPEN", -r["number"]))
    return rows[0] if rows else None


def new_issue(title: str, body: str) -> int:
    url = sh("gh", "issue", "create", "-R", REPO, "--title", title, "--body", body).strip()
    return int(url.rstrip("/").rsplit("/", 1)[-1])


def comment(number: int, body: str) -> None:
    sh("gh", "issue", "comment", str(number), "-R", REPO, "--body", body)


def already_posted(number: int, marker: str) -> bool:
    since = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = gh_json("api", f"repos/{REPO}/issues/{number}/comments?per_page=100&since={since}") or []
    return any(marker in (c.get("body") or "") for c in rows)


def post_report(today: str, extra: list[str]) -> bool:
    """Posts today's report once. Returns False when the publish run never wrote one."""
    text = git_show(f"origin/nfl-data:lab/reports/{today}.txt")
    issue = find_issue(REPORT_TITLE)
    if issue is None:
        num = new_issue(REPORT_TITLE, "Each morning the site's refresh writes a report on the last day's games: records, "
                                      "every pick predicted vs actual, where the model was off and what it changed in "
                                      "itself. GitHub posts it here as a comment, so it reaches you by email and in "
                                      "the GitHub app. Subscribe to this issue (or watch the repository) to get them.")
        sh("gh", "issue", "pin", str(num), "-R", REPO, check=False)
    else:
        num = issue["number"]
        if issue["state"] != "OPEN":
            sh("gh", "issue", "reopen", str(num), "-R", REPO, check=False)
    marker = f"<!-- lab-report {today} -->"
    if already_posted(num, marker):
        print(f"report {today}: already posted on #{num}")
        return text is not None
    if text is None:
        comment(num, f"{marker}\n@{OWNER} No report was written for {today}: the morning refresh did not finish. "
                     f"See the **{ALERT_TITLE}** issue.")
        return False
    body = f"{marker}\n@{OWNER}\n\n{report_markdown(text)}"
    if extra:
        body += "\n\n" + "\n".join(f"<sub>{x}</sub>" for x in extra)
    comment(num, body)
    print(f"report {today}: posted on #{num}")
    return True


# --------------------------------------------------------------------------- health

def keep_schedules_on() -> list[str]:
    """GitHub switches off scheduled workflows after 60 days without repository activity. Turning each one on again
    every day resets that clock; any that were already off are reported."""
    notes = []
    for wf in gh_json("api", f"repos/{REPO}/actions/workflows?per_page=100")["workflows"]:
        if wf["state"] != "active":
            notes.append(f"The **{wf['name']}** workflow had been switched off ({wf['state']}); it was switched back on.")
        sh("gh", "api", "-X", "PUT", f"repos/{REPO}/actions/workflows/{wf['id']}/enable", check=False)
    return notes


def workflow_problems(now: datetime) -> list[str]:
    out = []
    for wf, hours in STALE_HOURS.items():
        runs = gh_json("run", "list", "-R", REPO, "--workflow", wf, "-L", "20",
                       "--json", "status,conclusion,createdAt,url,event") or []
        done = [r for r in runs if r["status"] == "completed" and r["conclusion"] != "cancelled"]
        ok = [r for r in done if r["conclusion"] == "success"]
        last_ok = max((datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")) for r in ok), default=None)
        if last_ok is None or (now - last_ok).total_seconds() > hours * 3600:
            when = f"{(now - last_ok).total_seconds() / 3600:.0f} hours ago" if last_ok else "not in the last 20 runs"
            out.append(f"**{NAMES[wf]}** last succeeded {when}. Open [the workflow]({actions_url(wf)}), read the "
                       f"newest failed run, and press **Re-run all jobs** if it was a one-off (a data source down).")
        elif len(done) >= 3 and all(r["conclusion"] == "failure" for r in done[:3]):
            out.append(f"**{NAMES[wf]}** failed its last 3 runs ([newest]({done[0]['url']})).")
    return out


def data_problems(now: datetime, today: str, have_report: bool) -> tuple[list[str], list[str]]:
    problems, info = [], []
    commits = gh_json("api", f"repos/{REPO}/commits?sha=nfl-data&path=lab/state.json&per_page=1") or []
    if commits:
        at = datetime.fromisoformat(commits[0]["commit"]["committer"]["date"].replace("Z", "+00:00"))
        if (now - at).total_seconds() > 30 * 3600:
            problems.append(f"The Lab's top 10 and picks of the day were last saved {at:%b %d %H:%M} UTC. The "
                            f"**Build The Lab's top 10** step of [the publish run]({actions_url('publish-site.yml')}) "
                            f"is failing; its warning says why.")
    else:
        problems.append("The Lab's picks (lab/state.json on the nfl-data branch) could not be found.")
    if not have_report:
        problems.append(f"No daily report was written for {today}. The **Write the daily report** step of "
                        f"[the publish run]({actions_url('publish-site.yml')}) shows why.")
    for sport, ref in (("NBA", "origin/nba-data:status.json"),):
        st = json.loads(git_show(ref) or "{}")
        odds = st.get("odds") or {}
        errs = " ".join(str(e) for e in odds.get("errors") or [])
        if "401" in errs or "Unauthorized" in errs or "invalid" in errs.lower():
            problems.append(f"The Odds API turned down the key on the {sport} run ({errs[:160]}). Check the "
                            f"ODDS_API_KEY secret under Settings → Secrets and variables → Actions.")
        if odds.get("credits_remaining") is not None:
            info.append(f"Odds API credits left this month: {odds['credits_remaining']:.0f} (resets on the 1st).")
    try:
        site = gh_json("api", f"repos/{REPO}/pages")["html_url"]
        with urllib.request.urlopen(site, timeout=30) as r:
            if r.status != 200:
                problems.append(f"The site ({site}) answered {r.status}.")
    except Exception as ex:  # noqa: BLE001
        problems.append(f"The site could not be reached ({str(ex)[:120]}).")
    return problems, info


def update_alert(problems: list[str], today: str) -> None:
    issue = find_issue(ALERT_TITLE, state="open")
    listing = "\n".join(f"- {p}" for p in problems)
    if problems:
        body = (f"@{OWNER} The daily health check on {today} found:\n\n{listing}\n\nThe site keeps publishing with the "
                f"last good numbers while this is open. This issue closes by itself once the check passes.")
        if issue is None:
            new_issue(ALERT_TITLE, body)
        elif issue["body"].split("found:", 1)[-1].split("The site keeps", 1)[0].strip() != listing.strip():
            sh("gh", "issue", "edit", str(issue["number"]), "-R", REPO, "--body", body)
            comment(issue["number"], f"@{OWNER} Updated on {today}:\n\n{listing}")
        print("health: " + "; ".join(problems))
    elif issue is not None:
        comment(issue["number"], f"All clear on {today}: every workflow, The Lab's picks, the report and the site check out.")
        sh("gh", "issue", "close", str(issue["number"]), "-R", REPO)
        print("health: all clear, alert closed")
    else:
        print("health: all clear")


def main() -> int:
    now = datetime.now(timezone.utc)
    today = now.astimezone(ZoneInfo("America/Chicago")).date().isoformat()
    notes = keep_schedules_on()
    problems = workflow_problems(now)
    data, info = data_problems(now, today, git_show(f"origin/nfl-data:lab/reports/{today}.txt") is not None)
    post_report(today, info)
    problems += data
    update_alert(list(dict.fromkeys(notes + problems)), today)
    return 0


if __name__ == "__main__":
    sys.exit(main())
