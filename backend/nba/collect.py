"""Daily NBA collector: box scores, schedule, injury report, scoreboard and sportsbook prices.

  python -m nba.collect                 # download what is missing or stale, save today's snapshots
  python -m nba.collect --force-odds    # fetch prices again even if today's snapshot exists

Box scores are archived upstream, so they can always be downloaded again. Injury reports, the day's scoreboard
(ESPN's own spread and total) and sportsbook prices are not archived anywhere, so one copy per day is saved to the
archive folder (the hosted collector commits it to the nba-data branch).

Odds API budget. The free plan has 500 credits a month and the NFL Saturday pull needs about 90 of them each week.
Event list: free. Game lines (spread + total, every game): 2 credits, but only bought when ESPN's scoreboard (free,
DraftKings' spread and total) has none. Player props: 1 credit per market per game. On the free plan the pipeline
buys props only for the games and markets of the day's likeliest picks (fetch_props, NBA_PROP_CREDITS a day, default 3),
so The Lab's NBA picks stand on lines books really post. Nothing is bought below NBA_ODDS_RESERVE (default 200)
credits, so the NFL pull is never starved. On a paid plan (detected from the credit headers) the collector takes
props for every game that day, keeping 1,000 in reserve.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from engine.ingest import _ssl_context
from engine.util import utcnow

from . import sources

ODDS_API = "https://api.the-odds-api.com/v4/sports/basketball_nba"
PROP_MARKETS = {
    "points": "player_points",
    "rebounds": "player_rebounds",
    "assists": "player_assists",
    "threes": "player_threes",
    "pra": "player_points_rebounds_assists",
}
GAME_MARKETS = ("spreads", "totals")
FREE_PLAN_RESERVE = 200
FREE_PROP_CREDITS = 3     # props bought a day on the free plan, for the likeliest picks' games
PAID_PLAN_RESERVE = 1000
PAID_PLAN_MIN = 1000      # monthly allowance above this means a paid plan
STALE_HOURS = 6
ET = ZoneInfo("America/New_York")


def today_et(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(ET).date().isoformat()


def _fetch(url: str, params: dict | None = None, timeout: int = 120) -> tuple[bytes, dict]:
    full = f"{url}?{urllib.parse.urlencode(params)}" if params else url
    req = urllib.request.Request(full, headers={"User-Agent": "FourthAndGoalAnalytics/1.0 (NBA collector)"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as r:
                return r.read(), {k.lower(): v for k, v in r.headers.items()}
        except urllib.error.HTTPError:
            raise
        except Exception as ex:  # noqa: BLE001 - network blips: retry with backoff
            last = ex
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def _get_json(url: str, params: dict | None = None) -> tuple[object, dict]:
    body, hdr = _fetch(url, params)
    return json.loads(body), hdr


# --------------------------------------------------------------------------- box scores and schedule
def download_files(season: int = sources.CURRENT_SEASON, log=print, force: bool = False) -> list[dict]:
    """Every season's player box scores plus this season's schedule. Finished seasons are downloaded once;
    the current season is refreshed when the local copy is older than STALE_HOURS."""
    raw = sources.raw_dir()
    raw.mkdir(parents=True, exist_ok=True)
    plan = [("player_box", y) for y in range(sources.first_season(season), season + 1)] + [("schedule", season)]
    out = []
    for kind, yr in plan:
        dest = raw / sources.local_name(kind, yr)
        current = yr == season
        fresh = dest.exists() and (time.time() - dest.stat().st_mtime) < STALE_HOURS * 3600
        if dest.exists() and not force and (not current or fresh):
            out.append({"file": dest.name, "status": "kept"})
            continue
        try:
            body, _ = _fetch(sources.url_for(kind, yr), timeout=300)
            tmp = dest.with_suffix(".part")
            tmp.write_bytes(body)
            tmp.replace(dest)
            out.append({"file": dest.name, "status": "downloaded", "bytes": len(body)})
            log(f"nba: downloaded {dest.name} ({len(body) / 1e6:.1f} MB)")
        except Exception as ex:  # noqa: BLE001 - an older copy, when present, is still usable
            out.append({"file": dest.name, "status": f"failed: {ex}"})
            log(f"nba: {dest.name} not downloaded ({ex})")
    return out


def summarize_box(season: int = sources.CURRENT_SEASON) -> dict:
    """A quick check that the current season's file parses: games, player rows, last game date."""
    import pandas as pd  # noqa: PLC0415

    p = sources.raw_dir() / sources.local_name("player_box", season)
    if not p.exists():
        return {"season": season, "games": 0}
    d = pd.read_csv(p, low_memory=False, usecols=["game_id", "game_date", "team_abbreviation", "did_not_play"])
    d = d[d.team_abbreviation.isin(sources.NBA_TEAMS)]
    played = d[~d.did_not_play.fillna(False).astype(bool)]
    return {"season": season, "games": int(d.game_id.nunique()), "player_rows": int(len(played)),
            "last_game_date": None if d.empty else str(d.game_date.max())}


# --------------------------------------------------------------------------- ESPN daily snapshots
def save_espn(day: str, log=print) -> dict:
    """Today's injury report and scoreboard (with ESPN's listed spread and total), saved as published."""
    out = {}
    targets = {"injuries": (f"{sources.ESPN}/injuries", None),
               "scoreboard": (f"{sources.ESPN}/scoreboard", {"dates": day.replace("-", "")})}
    for name, (url, params) in targets.items():
        dest = sources.archive_dir() / name / f"{day}.json"
        try:
            data, _ = _get_json(url, params)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps({"fetched_at": utcnow(), "source": url, "data": data}))
            n = len(data.get("injuries" if name == "injuries" else "events", []))  # type: ignore[union-attr]
            out[name] = {"saved": dest.name, "items": n}
            log(f"nba: saved {name} for {day} ({n} {'teams' if name == 'injuries' else 'games'})")
        except Exception as ex:  # noqa: BLE001 - a missing day is recorded, not fatal
            out[name] = {"error": str(ex)}
            log(f"nba: {name} not saved ({ex})")
    return out


def espn_lines(scoreboard: dict | None) -> dict:
    """DraftKings' spread and total per game from ESPN's scoreboard (free): {(home, away): {total, home_spread}}."""
    out = {}
    for e in ((scoreboard or {}).get("data") or {}).get("events", []):
        c = (e.get("competitions") or [{}])[0]
        teams = {t.get("homeAway"): t.get("team", {}).get("abbreviation") for t in c.get("competitors", [])}
        o = (c.get("odds") or [None])[0]
        if not o or not teams.get("home") or not teams.get("away"):
            continue
        total, spread = o.get("overUnder"), o.get("spread")
        if total is None and spread is None:
            continue
        out[(teams["home"], teams["away"])] = {"total": None if total is None else float(total),
                                               "home_spread": None if spread is None else float(spread)}
    return out


def load_espn_lines(day: str) -> dict:
    f = sources.archive_dir() / "scoreboard" / f"{day}.json"
    return espn_lines(json.loads(f.read_text())) if f.exists() else {}


# --------------------------------------------------------------------------- the league's official injury report
OFFICIAL_INDEX = "https://official.nba.com/nba-injury-report-{y0}-{y1}-season/"
STATUSES = ("Out", "Doubtful", "Questionable", "Probable", "Available")


def parse_injury_report(text: str, teams: dict[str, str] | None = None) -> list[dict]:
    """Players and statuses from the text of the league's injury report PDF. Rows read like
    '10/26/2026 08:00 (ET) MEM@UTA Memphis Grizzlies Small, Javon Out Injury/Illness - Left Ankle; Sprain'; team names
    are swapped for their abbreviation first so they can't run into the player's last name."""
    import re  # noqa: PLC0415
    teams = teams or sources.TEAMS
    for full in sorted(teams, key=len, reverse=True):
        text = text.replace(full, f" @{teams[full]}@ ")
    word = r"[A-Z][A-Za-z'\-]+\.?"
    pat = re.compile(rf"(?:@([A-Z]{{2,4}})@\s+)?((?:{word} ){{0,2}}{word}(?: (?:Jr\.|Sr\.|II|III|IV))?), "
                     rf"({word}(?: {word})?) ({'|'.join(STATUSES)})\b(?: ([^\n]*))?")
    # Some PDFs extract one table cell per line: put a team, a status and its reason back on the player's line.
    status = rf"(?:{'|'.join(STATUSES)})"
    lines: list[str] = []
    for line in (x.strip() for x in text.splitlines()):
        if not line:
            continue
        prev = lines[-1] if lines else ""
        if prev.endswith("@") or (re.match(rf"{status}\b", line) and re.search(rf", {word}(?: {word})?$", prev)) \
                or (re.search(rf" {status}$", prev) and "," not in line and "@" not in line and not re.match(r"\d", line)):
            lines[-1] = f"{prev} {line}"
        else:
            lines.append(line)
    out, team = [], None
    for line in lines:
        for m in pat.finditer(line):
            team = m.group(1) or team
            out.append({"name": f"{m.group(3)} {m.group(2)}", "team": team, "status": m.group(4),
                        "reason": (m.group(5) or "").strip()})
    return out


def official_index_url(season: int = sources.CURRENT_SEASON) -> str:
    """The league's page for the season, named like nba-injury-report-2026-27-season (two-digit second year)."""
    return OFFICIAL_INDEX.format(y0=season - 1, y1=f"{season % 100:02d}")


def _latest_report_url(day: str, season: int = sources.CURRENT_SEASON) -> str | None:
    """The newest report PDF for `day` listed on the league's injury report page."""
    import re  # noqa: PLC0415
    req = urllib.request.Request(official_index_url(season), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60, context=_ssl_context()) as r:
        html = r.read().decode("utf-8", "replace")
    links = sorted(set(re.findall(rf"https://[^\"']+Injury-Report_{day}_[^\"']+\.pdf", html)))
    # names end in the report time (…_01_30PM.pdf): order by that time, not the text
    def when(u: str) -> tuple[int, int]:
        m = re.search(r"_(\d{2})(?:_(\d{2}))?(AM|PM)\.pdf$", u)
        if not m:
            return (0, 0)
        h = int(m.group(1)) % 12 + (12 if m.group(3) == "PM" else 0)
        return (h, int(m.group(2) or 0))
    return max(links, key=when) if links else None


def save_official_injuries(day: str, log=print) -> dict:
    """The league's official injury report (several a day on game days), saved as parsed rows. It is the source the
    teams file; ESPN's list can lag it."""
    try:
        url = _latest_report_url(day)
        if not url:
            log("nba: no official injury report posted yet today")
            return {"skipped": "not posted"}
        from io import BytesIO  # noqa: PLC0415

        from pypdf import PdfReader  # noqa: PLC0415
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60, context=_ssl_context()) as r:
            pdf = PdfReader(BytesIO(r.read()))
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        rows = parse_injury_report(text)
    except Exception as ex:  # noqa: BLE001 - ESPN's report still stands
        log(f"nba: official injury report not saved ({ex})")
        return {"error": str(ex)}
    if not rows:
        # a posted report always lists someone: nothing read means the PDF's layout changed. Keep ESPN's list and show
        # the start of the text in the run log so the parser can be fixed.
        log(f"nba: official injury report read no players ({url.rsplit('/', 1)[-1]}); text starts:\n{text[:1500]!r}")
        return {"error": "no players read", "report": url.rsplit("/", 1)[-1]}
    dest = sources.archive_dir() / "official_injuries" / f"{day}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"fetched_at": utcnow(), "source": url, "players": rows}))
    log(f"nba: saved the official injury report ({len(rows)} players, {url.rsplit('/', 1)[-1]})")
    return {"saved": dest.name, "players": len(rows), "report": url.rsplit("/", 1)[-1]}


def save_rosters(day: str, log=print) -> dict:
    """Every team's current roster (ESPN athlete ids, the same ids as the box scores). A player traded or signed in
    the offseason stays on his old team in the box scores until he plays for the new one; the roster corrects that."""
    dest = sources.archive_dir() / "rosters" / f"{day}.json"
    teams, errors = {}, {}
    for team in sorted(sources.NBA_TEAMS):
        try:
            data, _ = _get_json(f"{sources.ESPN}/teams/{team.lower()}/roster")
            teams[team] = [{"id": str(a["id"]), "name": a.get("displayName", "")} for a in data.get("athletes", []) if a.get("id")]
        except Exception as ex:  # noqa: BLE001 - a team that fails keeps the box-score roster
            errors[team] = str(ex)
    if teams:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({"fetched_at": utcnow(), "source": f"{sources.ESPN}/teams/{{team}}/roster", "teams": teams}))
    log(f"nba: saved rosters for {len(teams)} teams" + (f" ({len(errors)} failed)" if errors else ""))
    return {"teams": len(teams), "errors": errors}


# --------------------------------------------------------------------------- sportsbook prices
def _credits(hdr: dict) -> tuple[float | None, float | None]:
    def num(k):
        try:
            return float(hdr[k])
        except (KeyError, TypeError, ValueError):
            return None
    return num("x-requests-remaining"), num("x-requests-used")


def plan_budget(remaining: float | None, used: float | None, n_games: int, mode: str = "auto", espn_lines: bool = False) -> dict:
    """Decide what today's pull may spend. Never spends below the reserve that protects the NFL weekly pull. Game lines
    are skipped when ESPN's scoreboard already lists them (free)."""
    if remaining is None:
        return {"plan": "unknown", "game_lines": False, "props": False, "reason": "credit balance unavailable"}
    allowance = remaining + (used or 0)
    paid = allowance > PAID_PLAN_MIN
    reserve = float(os.environ.get("NBA_ODDS_RESERVE", PAID_PLAN_RESERVE if paid else FREE_PLAN_RESERVE))
    lines_cost = len(GAME_MARKETS)
    props_cost = n_games * len(PROP_MARKETS)
    afford = n_games > 0 and remaining - (0 if espn_lines else lines_cost) >= reserve
    lines = afford and not espn_lines
    want_props = mode == "always" or (mode == "auto" and paid)
    props = afford and want_props and remaining - (lines_cost if lines else 0) - props_cost >= reserve
    reason = ("no games today" if n_games == 0 else
              f"would drop below the {reserve:.0f}-credit reserve" if not afford else
              "free plan: player props need a paid plan" if not want_props and mode == "auto" else
              "player props turned off" if not want_props else
              f"props would drop below the {reserve:.0f}-credit reserve" if not props else "ok")
    return {"plan": "paid" if paid else "free", "allowance": allowance, "reserve": reserve, "remaining": remaining,
            "game_lines": lines, "espn_lines": espn_lines,
            "props": props, "cost": (lines_cost if lines else 0) + (props_cost if props else 0), "reason": reason}


def fetch_odds(day: str, key: str, log=print, mode: str = "auto", now: datetime | None = None, espn_lines: bool = False) -> dict:
    now = now or datetime.now(timezone.utc)
    start = datetime.fromisoformat(day).replace(tzinfo=ET)
    lo, hi = max(now, start.astimezone(timezone.utc)), (start + timedelta(days=1, hours=6)).astimezone(timezone.utc)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    events, hdr = _get_json(f"{ODDS_API}/events", {"apiKey": key, "commenceTimeFrom": lo.strftime(fmt),
                                                   "commenceTimeTo": hi.strftime(fmt)})
    events = [e for e in events if sources.TEAMS.get(e.get("home_team")) and sources.TEAMS.get(e.get("away_team"))]  # type: ignore[union-attr]
    remaining, used = _credits(hdr)
    budget = plan_budget(remaining, used, len(events), mode, espn_lines)
    log(f"nba odds: {len(events)} games today; plan {budget['plan']}, {remaining} credits remaining; "
        f"game lines {'yes' if budget['game_lines'] else 'from ESPN' if espn_lines else 'no'}, "
        f"props {'yes' if budget['props'] else 'no'} ({budget['reason']})")
    games = [{"event_id": e["id"], "commence_time": e["commence_time"], "home": sources.TEAMS[e["home_team"]],
              "away": sources.TEAMS[e["away_team"]]} for e in events]
    lines, props, errors = [], [], []
    if budget["game_lines"]:
        try:
            data, hdr = _get_json(f"{ODDS_API}/odds", {"apiKey": key, "regions": "us", "oddsFormat": "american",
                                                       "markets": ",".join(GAME_MARKETS),
                                                       "commenceTimeFrom": lo.strftime(fmt), "commenceTimeTo": hi.strftime(fmt)})
            remaining = _credits(hdr)[0] or remaining
            for e in data:  # type: ignore[union-attr]
                for b in e.get("bookmakers", []):
                    for m in b.get("markets", []):
                        for o in m.get("outcomes", []):
                            lines.append({"event_id": e["id"], "book": b["key"], "market": m["key"],
                                          "team": sources.TEAMS.get(o.get("name"), o.get("name")), "point": o.get("point"),
                                          "price": o.get("price"), "updated": m.get("last_update")})
        except urllib.error.HTTPError as ex:
            errors.append(f"game lines: HTTP {ex.code}")
    if budget["props"]:
        for g in games:
            try:
                got, remaining = _event_props(key, g["event_id"], list(PROP_MARKETS), remaining)
                props += got
            except urllib.error.HTTPError as ex:
                errors.append(f"{g['away']}@{g['home']}: HTTP {ex.code}")
    return {"date": day, "fetched_at": utcnow(), "source": "The Odds API (the-odds-api.com), US books",
            "budget": budget, "games": games, "game_lines": lines, "props": props, "errors": errors,
            "credits_remaining": remaining}


def _event_props(key: str, event_id: str, markets: list[str], remaining: float | None) -> tuple[list[dict], float | None]:
    """One game's player props for the given markets (1 credit per market)."""
    feed_to_ours = {v: k for k, v in PROP_MARKETS.items()}
    data, hdr = _get_json(f"{ODDS_API}/events/{event_id}/odds",
                          {"apiKey": key, "regions": "us", "oddsFormat": "american",
                           "markets": ",".join(PROP_MARKETS[m] for m in markets)})
    out = []
    for b in data.get("bookmakers", []):  # type: ignore[union-attr]
        for m in b.get("markets", []):
            market = feed_to_ours.get(m["key"])
            for o in m.get("outcomes", []) if market else []:
                side = str(o.get("name", "")).lower()
                if side not in ("over", "under") or o.get("price") is None:
                    continue
                out.append({"event_id": event_id, "market": market, "player": o.get("description") or "",
                            "book": b["key"], "side": side, "line": o.get("point"), "price": int(o["price"]),
                            "updated": m.get("last_update")})
    return out, _credits(hdr)[0] or remaining


def plan_props(wants: list[tuple[str, str, str]], remaining: float | None, reserve: float, cap: int) -> list[tuple[str, str, str]]:
    """The (home, away, market) pairs to buy, likeliest pick first: one credit each, at most `cap`, never below the
    reserve, each pair once."""
    if remaining is None:
        return []
    room = int(min(cap, remaining - reserve))
    out: list[tuple[str, str, str]] = []
    for w in wants:
        if len(out) >= room:
            break
        if w not in out:
            out.append(w)
    return out


def fetch_props(day: str, wants: list[tuple[str, str, str]], log=print) -> dict:
    """Buy real prop lines for the games and markets of the day's likeliest picks (free plan) and add them to today's
    odds file. Once a day: a file that already holds props is left alone."""
    key = os.environ.get("ODDS_API_KEY", "").strip()
    f = sources.archive_dir() / "odds" / f"{day}.json"
    if not key or not f.exists():
        return {"skipped": "no key" if not key else "no odds file"}
    snap = json.loads(f.read_text())
    if snap.get("props"):
        return {"skipped": "props already bought today"}
    budget = snap.get("budget") or {}
    remaining = snap.get("credits_remaining")
    cap = int(os.environ.get("NBA_PROP_CREDITS", FREE_PROP_CREDITS))
    buy = plan_props(wants, remaining, float(budget.get("reserve", FREE_PLAN_RESERVE)), cap)
    ev = {(g["home"], g["away"]): g["event_id"] for g in snap.get("games", [])}
    by_game: dict[tuple[str, str], list[str]] = {}
    for h, a, m in buy:
        if (h, a) in ev:
            by_game.setdefault((h, a), []).append(m)
    props, errors = [], []
    for (h, a), markets in by_game.items():
        try:
            got, remaining = _event_props(key, ev[(h, a)], markets, remaining)
            props += got
        except Exception as ex:  # noqa: BLE001 - a game that fails keeps its usual lines
            errors.append(f"{a}@{h}: {ex}")
    snap["props"] = props
    snap["targeted"] = [{"home": h, "away": a, "markets": m} for (h, a), m in by_game.items()]
    snap["credits_remaining"] = remaining
    snap["errors"] = snap.get("errors", []) + errors
    f.write_text(json.dumps(snap))
    log(f"nba odds: bought {sum(len(m) for m in by_game.values())} prop markets in {len(by_game)} games "
        f"({len(props)} prices); {remaining} credits remaining")
    return {"games": len(by_game), "prices": len(props), "credits_remaining": remaining, "errors": errors}


def save_odds(day: str, log=print, force: bool = False, now: datetime | None = None) -> dict:
    key = os.environ.get("ODDS_API_KEY", "").strip()
    if not key:
        log("nba odds: ODDS_API_KEY not set; skipping")
        return {"skipped": "no key"}
    dest = sources.archive_dir() / "odds" / f"{day}.json"
    if dest.exists() and not force:
        prev = json.loads(dest.read_text())
        # A day that bought nothing (budget or errors) may try again on a later run; one that bought prices, or took
        # its game lines from ESPN, is kept.
        if prev.get("game_lines") or prev.get("props") or (prev.get("budget") or {}).get("espn_lines"):
            log(f"nba odds: keeping {dest.name} from {prev['fetched_at']}")
            return {"kept": dest.name}
    try:
        snap = fetch_odds(day, key, log, os.environ.get("NBA_PROPS", "auto").lower(), now, espn_lines=bool(load_espn_lines(day)))
    except Exception as ex:  # noqa: BLE001 - prices are optional
        log(f"nba odds: not fetched ({ex})")
        return {"error": str(ex)}
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(snap))
    log(f"nba odds: saved {len(snap['game_lines'])} game-line prices and {len(snap['props'])} prop prices; "
        f"{snap['credits_remaining']} credits remaining")
    return {"saved": dest.name, "game_lines": len(snap["game_lines"]), "props": len(snap["props"]),
            "budget": snap["budget"], "credits_remaining": snap["credits_remaining"], "errors": snap["errors"]}


# --------------------------------------------------------------------------- run
def run(log=print, force_odds: bool = False, force_files: bool = False) -> dict:
    day = today_et()
    files = download_files(log=log, force=force_files)
    status = {"date": day, "ran_at": utcnow(), "files": files, "box_scores": summarize_box(),
              "espn": save_espn(day, log), "official_injuries": save_official_injuries(day, log), "rosters": save_rosters(day, log), "odds": save_odds(day, log, force_odds), "license": sources.LICENSE_NOTE}
    arch = sources.archive_dir()
    arch.mkdir(parents=True, exist_ok=True)
    (arch / "status.json").write_text(json.dumps(status, indent=2))
    with (arch / "runs.jsonl").open("a") as f:
        f.write(json.dumps({k: status[k] for k in ("date", "ran_at", "box_scores")} |
                           {"odds": {k: v for k, v in status["odds"].items() if k != "budget"}}) + "\n")
    return status


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="nba.collect")
    ap.add_argument("--force-odds", action="store_true")
    ap.add_argument("--force-files", action="store_true")
    a = ap.parse_args(argv)
    st = run(force_odds=a.force_odds, force_files=a.force_files)
    print(json.dumps({k: st[k] for k in ("date", "box_scores", "espn", "odds")}, indent=2, default=str))
    failed = [f for f in st["files"] if str(f["status"]).startswith("failed") and not (sources.raw_dir() / f["file"]).exists()]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
