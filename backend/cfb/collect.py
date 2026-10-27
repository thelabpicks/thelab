"""Daily college football collector: scores, schedules, closing lines, box scores, the ESPN scoreboard and
sportsbook prices.

  python -m cfb.collect                 # download what is missing or stale, save today's snapshots
  python -m cfb.collect --force-odds    # fetch prices again even if this week's pull is done

Scores, schedules, closing lines and box scores are archived upstream (cfbfastR / sportsdataverse), so they can always
be downloaded again. The ESPN scoreboard for the coming week (with ESPN's posted spread, total and moneyline for every
FBS game, free) and sportsbook prices are not archived anywhere, so one copy per day is saved to the archive folder
(the hosted collector commits it to the cfb-data branch).

Odds API budget. The free plan has 500 credits a month, shared with the NFL Saturday pull (about 90 a week) and the
NBA daily game lines. College football takes:
  * game lines (moneyline, spread, total for every FBS game this week, one call): 3 credits, on Tuesday (early lines,
    where the totals model did best in testing) and on Saturday morning (near-closing lines for grading);
  * team totals for up to FEATURED games (1 credit a game) on Saturday;
  * player props (passing, rushing, receiving yards and receptions: 4 credits a game) for the top featured game on the
    free plan and every featured game on a paid plan;
  * alternate spreads and totals (every point a book offers, 2 credits a game) on Saturday: every game on a paid plan,
    and on the free plan only the first CFB_ALT_GAMES featured games (default 0, since the free plan is spoken for).
About 12 credits a week. Nothing is bought if it would leave fewer than CFB_ODDS_RESERVE (default 200) credits, so the
NFL pull is never starved. ESPN's lines fill in every other day and every other game for free.
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
from zoneinfo import ZoneInfo

from engine.ingest import _ssl_context
from engine.util import utcnow

from . import sources

ODDS_API = "https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf"
GAME_MARKETS = ("h2h", "spreads", "totals")
PROP_MARKETS = {"pass_yds": "player_pass_yds", "rush_yds": "player_rush_yds", "rec_yds": "player_reception_yds",
                "receptions": "player_receptions"}
ALT_MARKETS = {"alternate_spreads": "spreads", "alternate_totals": "totals"}
FEATURED = 4
FREE_PLAN_RESERVE = 200
PAID_PLAN_RESERVE = 1000
PAID_PLAN_MIN = 1000
STALE_HOURS = {"schedule": 6, "lines": 24, "pbp": 24, "team_box": 6, "player_box": 6}
LINE_DAYS = (1, 5)            # Tuesday, Saturday (Monday = 0)
ET = ZoneInfo("America/New_York")


def today_et(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(ET).date().isoformat()


def _fetch(url: str, params: dict | None = None, timeout: int = 120) -> tuple[bytes, dict]:
    full = f"{url}?{urllib.parse.urlencode(params)}" if params else url
    req = urllib.request.Request(full, headers={"User-Agent": "TheLab/1.0 (college football collector)"})
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


# --------------------------------------------------------------------------- upstream files
def plan_files(season: int = sources.CURRENT_SEASON) -> list[tuple[str, int | None]]:
    plan: list[tuple[str, int | None]] = [("schedule", y) for y in range(sources.FIRST_SEASON, season + 1)]
    plan += [("team_box", y) for y in range(sources.FIRST_SEASON + 2, season + 1)]
    plan += [("player_box", y) for y in range(season - sources.PROP_SEASONS - 2, season + 1)]
    plan += [("lines", None)]
    plan += [("pbp", y) for y in range(sources.FIRST_TEST_SEASON, season + 1)]
    return plan


def download_files(season: int = sources.CURRENT_SEASON, log=print, force: bool = False) -> list[dict]:
    """Finished seasons are downloaded once; the current season (and the betting file) are refreshed when the local
    copy is older than STALE_HOURS."""
    raw = sources.raw_dir()
    raw.mkdir(parents=True, exist_ok=True)
    out = []
    for kind, yr in plan_files(season):
        dest = raw / sources.local_name(kind, yr)
        current = yr is None or yr == season
        fresh = dest.exists() and (time.time() - dest.stat().st_mtime) < STALE_HOURS[kind] * 3600
        stats = raw / sources.local_name("pbp_stats", yr) if kind == "pbp" else None
        if stats is not None and not current and stats.exists() and not force:
            out.append({"file": stats.name, "status": "kept"})   # finished season: only the per-game summary is kept
            continue
        if dest.exists() and not force and (not current or fresh):
            if stats is not None and not stats.exists():
                _summarize_pbp(dest, stats, log, keep=current)
            out.append({"file": dest.name, "status": "kept"})
            continue
        try:
            body, _ = _fetch(sources.url_for(kind, yr), timeout=600)
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(body)
            tmp.replace(dest)
            out.append({"file": dest.name, "status": "downloaded", "bytes": len(body)})
            log(f"cfb: downloaded {dest.name} ({len(body) / 1e6:.1f} MB)")
            if stats is not None:
                _summarize_pbp(dest, stats, log, keep=current)
        except Exception as ex:  # noqa: BLE001 - an older copy, when present, is still usable
            out.append({"file": dest.name, "status": f"failed: {ex}"})
            log(f"cfb: {dest.name} not downloaded ({ex})")
    return out


def _summarize_pbp(src, dest, log=print, keep: bool = True) -> None:
    """Play-by-play files are 70-130 MB a season; the model needs only per-game efficiency, so that is saved and a
    finished season's play-by-play is deleted. The current season's file is kept (its lines are read from it)."""
    from . import history  # noqa: PLC0415

    try:
        history.aggregate_pbp(src).to_csv(dest, index=False)
        log(f"cfb: summarized {src.name} -> {dest.name}")
    except Exception as ex:  # noqa: BLE001 - the model runs without it, just with less information
        log(f"cfb: could not summarize {src.name} ({ex})")
        return
    if not keep:
        src.unlink(missing_ok=True)


# --------------------------------------------------------------------------- ESPN scoreboard and poll
def _scoreboard(start: datetime, log=print) -> tuple[dict, dict]:
    """ESPN's FBS scoreboard for the eight days from `start`. The one-call date range is tried first; when ESPN turns it
    down (it has answered 400 to ranges), each day is asked for on its own and the games are merged."""
    url = f"{sources.ESPN}/scoreboard"
    span = {"dates": f"{start:%Y%m%d}-{start + timedelta(days=7):%Y%m%d}", "groups": "80"}
    try:
        data, _ = _get_json(url, span)
        return data, span  # type: ignore[return-value]
    except Exception as ex:  # noqa: BLE001 - fall back to one call per day
        log(f"cfb: scoreboard range refused ({ex}); asking day by day")
    events, errors = {}, []
    for i in range(8):
        d = f"{start + timedelta(days=i):%Y%m%d}"
        try:
            data, _ = _get_json(url, {"dates": d, "groups": "80"})
        except Exception as ex:  # noqa: BLE001
            errors.append(f"{d}: {ex}")
            continue
        for e in data.get("events", []):  # type: ignore[union-attr]
            events.setdefault(e.get("id"), e)
    if not events and errors:
        raise RuntimeError("; ".join(errors[:3]))
    return {"events": list(events.values())}, {"dates": "by day", "groups": "80", "errors": errors}


def save_espn(day: str, log=print) -> dict:
    """The next eight days of FBS games with ESPN's posted lines and AP ranks, and the latest AP poll."""
    out = {}
    start = datetime.fromisoformat(day)
    targets = {"scoreboard": lambda: _scoreboard(start, log),
               "rankings": lambda: (_get_json(f"{sources.ESPN}/rankings")[0], None)}
    for name, get in targets.items():
        dest = sources.archive_dir() / name / f"{day}.json"
        try:
            data, params = get()
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps({"fetched_at": utcnow(), "source": f"{sources.ESPN}/{name}", "params": params, "data": data}))
            n = len(data.get("events" if name == "scoreboard" else "rankings", []))  # type: ignore[union-attr]
            out[name] = {"saved": dest.name, "items": n}
            log(f"cfb: saved {name} for {day} ({n})")
        except Exception as ex:  # noqa: BLE001 - a missing day is recorded, not fatal
            out[name] = {"error": str(ex)}
            log(f"cfb: {name} not saved ({ex})")
    return out


def parse_scoreboard(snap: dict) -> list[dict]:
    """One row per game: ESPN ids, kickoff, AP ranks, TV, and ESPN's posted home spread, total and moneylines."""
    rows = []
    for e in (snap.get("data") or {}).get("events", []):
        try:
            c = e["competitions"][0]
            teams = {t["homeAway"]: t for t in c["competitors"]}
            h, a = teams["home"], teams["away"]
        except (KeyError, IndexError, TypeError):
            continue
        rank = lambda t: (t.get("curatedRank") or {}).get("current")  # noqa: E731
        row = {"game_id": int(e["id"]), "date": e.get("date"), "home_id": int(h["team"]["id"]), "away_id": int(a["team"]["id"]),
               "home_rank": rank(h) if rank(h) and rank(h) <= 25 else None,
               "away_rank": rank(a) if rank(a) and rank(a) <= 25 else None,
               "tv": ", ".join(n for b in c.get("broadcasts", []) for n in b.get("names", [])) or None,
               "neutral": bool(c.get("neutralSite")), "status": ((e.get("status") or {}).get("type") or {}).get("name"),
               "home_spread": None, "total": None, "ml_home": None, "ml_away": None, "provider": None}
        odds = (c.get("odds") or [None])[0]
        if odds:
            row["provider"] = (odds.get("provider") or {}).get("name")
            row["total"] = _f(odds.get("overUnder"))
            sp = _f(odds.get("spread"))
            if sp is None:
                sp = _spread_from_details(odds.get("details"), h, a)
            row["home_spread"] = sp
            row["ml_home"] = _f((odds.get("homeTeamOdds") or {}).get("moneyLine"))
            row["ml_away"] = _f((odds.get("awayTeamOdds") or {}).get("moneyLine"))
            # ESPN now posts the moneyline under odds.moneyline.{home,away}.{close,current,open}.odds (e.g. "-115")
            for side in ("home", "away"):
                if row[f"ml_{side}"] is None:
                    row[f"ml_{side}"] = _espn_price((odds.get("moneyline") or {}).get(side) or {})
        rows.append(row)
    return rows


def _f(v) -> float | None:
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def _espn_price(m: dict) -> float | None:
    """The latest American price in one side of ESPN's moneyline block: close, then current, then open."""
    for k in ("close", "current", "open"):
        v = str((m.get(k) or {}).get("odds") or "").strip().upper()
        if v in ("EVEN", "EV"):
            return 100.0
        x = _f(v.replace("+", ""))
        if x is not None and abs(x) >= 100:
            return x
    return None


def _spread_from_details(details, h: dict, a: dict) -> float | None:
    """ESPN's "details" reads like "ALA -7.5" or "EVEN": the favorite's abbreviation and its line."""
    if not details:
        return None
    if str(details).strip().upper() in ("EVEN", "PK", "PICK"):
        return 0.0
    parts = str(details).split()
    if len(parts) != 2:
        return None
    line = _f(parts[1])
    if line is None:
        return None
    if parts[0] == h["team"].get("abbreviation"):
        return line
    if parts[0] == a["team"].get("abbreviation"):
        return -line
    return None


# --------------------------------------------------------------------------- sportsbook prices
def _credits(hdr: dict) -> tuple[float | None, float | None]:
    def num(k):
        try:
            return float(hdr[k])
        except (KeyError, TypeError, ValueError):
            return None
    return num("x-requests-remaining"), num("x-requests-used")


def plan_budget(remaining: float | None, used: float | None, n_games: int, n_featured: int, weekday: int,
                mode: str = "auto", have_lines_this_week: bool = False) -> dict:
    """Decide what today's pull may spend. Never spends below the reserve that protects the NFL weekly pull."""
    if remaining is None:
        return {"plan": "unknown", "game_lines": False, "team_totals": 0, "props": 0, "alt": 0, "reason": "credit balance unavailable"}
    allowance = remaining + (used or 0)
    paid = allowance > PAID_PLAN_MIN
    reserve = float(os.environ.get("CFB_ODDS_RESERVE", PAID_PLAN_RESERVE if paid else FREE_PLAN_RESERVE))
    # Tuesday and Saturday; Wednesday-Friday only if Tuesday's pull did not happen; never Sunday or Monday
    lines_day = weekday in LINE_DAYS or (weekday in (2, 3, 4) and not have_lines_this_week)
    lines_cost = len(GAME_MARKETS)
    lines = n_games > 0 and lines_day and remaining - lines_cost >= reserve
    left = remaining - (lines_cost if lines else 0)
    featured_day = lines and (weekday == 5 or mode == "always")   # extras only alongside the game lines
    tt = min(n_featured, FEATURED) if featured_day else 0
    tt = int(max(0, min(tt, left - reserve)))
    left -= tt
    want_props = mode != "never" and featured_day
    n_props = (min(n_featured, FEATURED) if (paid or mode == "always") else min(n_featured, 1)) if want_props else 0
    while n_props and left - n_props * len(PROP_MARKETS) < reserve:
        n_props -= 1
    left -= n_props * len(PROP_MARKETS)
    n_alt = (n_games if paid else min(n_featured, int(os.environ.get("CFB_ALT_GAMES", "0") or 0))) if featured_day else 0
    n_alt = int(max(0, min(n_alt, (left - reserve) // len(ALT_MARKETS))))
    reason = ("no games this week" if n_games == 0 else
              "not a line day (Tuesday and Saturday)" if not lines_day else
              f"would drop below the {reserve:.0f}-credit reserve" if not lines else "ok")
    return {"plan": "paid" if paid else "free", "allowance": allowance, "reserve": reserve, "game_lines": lines,
            "team_totals": tt, "props": n_props, "alt": n_alt,
            "cost": (lines_cost if lines else 0) + tt + n_props * len(PROP_MARKETS) + n_alt * len(ALT_MARKETS), "reason": reason}


def match_team(name: str, teams: dict[str, int]) -> int | None:
    """The Odds API calls teams "Alabama Crimson Tide"; schedules say "Alabama". Longest school name that the full
    name starts with wins ("Miami (OH) RedHawks" -> "Miami (OH)", not "Miami")."""
    best = None
    for school, tid in teams.items():
        if name == school or name.startswith(school + " "):
            if best is None or len(school) > len(best[0]):
                best = (school, tid)
    return best[1] if best else None


def fetch_odds(day: str, key: str, week_games: list[dict], featured: list[int], log=print, mode: str = "auto",
               now: datetime | None = None, have_lines_this_week: bool = False) -> dict:
    now = now or datetime.now(timezone.utc)
    lo, hi = now, now + timedelta(days=7)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    events, hdr = _get_json(f"{ODDS_API}/events", {"apiKey": key, "commenceTimeFrom": lo.strftime(fmt),
                                                   "commenceTimeTo": hi.strftime(fmt)})
    teams = {g["home_team"]: g["home_id"] for g in week_games} | {g["away_team"]: g["away_id"] for g in week_games}
    by_pair = {(g["home_id"], g["away_id"]): g["game_id"] for g in week_games}
    games = []
    for e in events:  # type: ignore[union-attr]
        h, a = match_team(e.get("home_team", ""), teams), match_team(e.get("away_team", ""), teams)
        gid = by_pair.get((h, a))
        flipped = not gid and bool(by_pair.get((a, h)))
        gid = gid or by_pair.get((a, h))
        if gid:
            # "home" and "away" always mean the schedule's sides: when the feed lists them the other way round
            # (neutral sites), its names are swapped so every price lands on the right team
            home, away = (e["away_team"], e["home_team"]) if flipped else (e["home_team"], e["away_team"])
            games.append({"event_id": e["id"], "game_id": gid, "commence_time": e["commence_time"],
                          "home": home, "away": away, "flipped": flipped})
    remaining, used = _credits(hdr)
    feat_events = [g for f in featured for g in games if g["game_id"] == f]
    budget = plan_budget(remaining, used, len(games), len(feat_events), datetime.fromisoformat(day).weekday(), mode,
                         have_lines_this_week)
    log(f"cfb odds: {len(games)} games matched this week; plan {budget['plan']}, {remaining} credits remaining; "
        f"lines {'yes' if budget['game_lines'] else 'no'}, team totals {budget['team_totals']}, props {budget['props']}, "
        f"alternate lines {budget['alt']} "
        f"({budget['reason']})")
    lines, team_totals, props, alt_lines, errors = [], [], [], [], []
    ev = {g["event_id"]: g for g in games}
    if budget["game_lines"]:
        try:
            data, hdr = _get_json(f"{ODDS_API}/odds", {"apiKey": key, "regions": "us", "oddsFormat": "american",
                                                       "markets": ",".join(GAME_MARKETS),
                                                       "commenceTimeFrom": lo.strftime(fmt), "commenceTimeTo": hi.strftime(fmt)})
            remaining = _credits(hdr)[0] or remaining
            for e in data:  # type: ignore[union-attr]
                g = ev.get(e["id"])
                if not g:
                    continue
                for b in e.get("bookmakers", []):
                    for m in b.get("markets", []):
                        for o in m.get("outcomes", []):
                            side = ("home" if o.get("name") == g["home"] else "away" if o.get("name") == g["away"]
                                    else str(o.get("name", "")).lower())
                            lines.append({"game_id": g["game_id"], "book": b["key"], "market": m["key"], "side": side,
                                          "point": o.get("point"), "price": o.get("price"), "updated": m.get("last_update")})
        except urllib.error.HTTPError as ex:
            errors.append(f"game lines: HTTP {ex.code}")
    # featured games first, so the free plan's few alternate-line games are the featured ones
    order = feat_events + [g for g in games if g not in feat_events]
    for i, g in enumerate(order):
        markets = []
        if i < len(feat_events) and i < budget["team_totals"]:
            markets.append("team_totals")
        if i < len(feat_events) and i < budget["props"]:
            markets += list(PROP_MARKETS.values())
        if i < budget["alt"]:
            markets += list(ALT_MARKETS)
        if not markets:
            continue
        try:
            data, hdr = _get_json(f"{ODDS_API}/events/{g['event_id']}/odds",
                                  {"apiKey": key, "regions": "us", "oddsFormat": "american", "markets": ",".join(markets)})
        except urllib.error.HTTPError as ex:
            errors.append(f"{g['away']} at {g['home']}: HTTP {ex.code}")
            continue
        remaining = _credits(hdr)[0] or remaining
        feed_to_ours = {v: k for k, v in PROP_MARKETS.items()}
        for b in data.get("bookmakers", []):  # type: ignore[union-attr]
            for m in b.get("markets", []):
                for o in m.get("outcomes", []):
                    if m["key"] in ALT_MARKETS:
                        if o.get("price") is None or o.get("point") is None:
                            continue
                        side = ("home" if o.get("name") == g["home"] else "away" if o.get("name") == g["away"]
                                else str(o.get("name", "")).lower())
                        alt_lines.append({"game_id": g["game_id"], "book": b["key"], "market": ALT_MARKETS[m["key"]], "side": side,
                                          "point": o["point"], "price": int(o["price"])})
                        continue
                    side = str(o.get("name", "")).lower()
                    if side not in ("over", "under") or o.get("price") is None:
                        continue
                    if m["key"] == "team_totals":
                        team = o.get("description") or ""
                        team_totals.append({"game_id": g["game_id"], "book": b["key"],
                                            "team": "home" if team == g["home"] else "away" if team == g["away"] else team,
                                            "side": side, "line": o.get("point"), "price": int(o["price"])})
                    elif m["key"] in feed_to_ours:
                        props.append({"game_id": g["game_id"], "market": feed_to_ours[m["key"]],
                                      "player": o.get("description") or "", "book": b["key"], "side": side,
                                      "line": o.get("point"), "price": int(o["price"])})
    return {"date": day, "fetched_at": utcnow(), "source": "The Odds API (the-odds-api.com), US books", "budget": budget,
            "games": games, "game_lines": lines, "team_totals": team_totals, "props": props, "alt_lines": alt_lines, "errors": errors,
            "credits_remaining": remaining}


def week_games(day: str) -> list[dict]:
    """This week's games from the schedule file (ids and names), for matching the odds feed."""
    import pandas as pd  # noqa: PLC0415

    from . import history  # noqa: PLC0415

    try:
        s = history.load_schedule(sources.CURRENT_SEASON, sources.CURRENT_SEASON)
    except FileNotFoundError:
        return []
    t0 = pd.Timestamp(day)
    w = s[(s.date >= t0 - pd.Timedelta(hours=12)) & (s.date < t0 + pd.Timedelta(days=8)) & ~s.final]
    return w[["game_id", "home_id", "away_id", "home_team", "away_team"]].to_dict("records")


def featured_games(day: str, limit: int = FEATURED) -> list[int]:
    """Ranked-vs-ranked games first (by combined AP rank), then games with one top-10 team, from today's scoreboard."""
    f = sources.archive_dir() / "scoreboard" / f"{day}.json"
    if not f.exists():
        return []
    rows = [r for r in parse_scoreboard(json.loads(f.read_text())) if r["status"] in (None, "STATUS_SCHEDULED")]
    both = sorted((r for r in rows if r["home_rank"] and r["away_rank"]), key=lambda r: r["home_rank"] + r["away_rank"])
    top10 = sorted((r for r in rows if r not in both and min(r["home_rank"] or 99, r["away_rank"] or 99) <= 10),
                   key=lambda r: min(r["home_rank"] or 99, r["away_rank"] or 99))
    return [r["game_id"] for r in (both + top10)[:limit]]


def save_odds(day: str, log=print, force: bool = False, now: datetime | None = None) -> dict:
    key = os.environ.get("ODDS_API_KEY", "").strip()
    if not key:
        log("cfb odds: ODDS_API_KEY not set; skipping")
        return {"skipped": "no key"}
    dest = sources.archive_dir() / "odds" / f"{day}.json"
    if dest.exists() and not force:
        prev = json.loads(dest.read_text())
        if prev.get("game_lines") or prev.get("props") or prev.get("team_totals"):
            log(f"cfb odds: keeping {dest.name} from {prev['fetched_at']}")
            return {"kept": dest.name}
    wk = week_games(day)
    start = datetime.fromisoformat(day)
    since_tuesday = [start - timedelta(days=i) for i in range(1, start.weekday())]   # empty on Sunday-Tuesday
    have = any((sources.archive_dir() / "odds" / f"{d:%Y-%m-%d}.json").exists() for d in since_tuesday)
    try:
        snap = fetch_odds(day, key, wk, featured_games(day), log, os.environ.get("CFB_PROPS", "auto").lower(), now, have)
    except Exception as ex:  # noqa: BLE001 - prices are optional
        log(f"cfb odds: not fetched ({ex})")
        return {"error": str(ex)}
    if not (snap["game_lines"] or snap["props"] or snap["team_totals"] or snap["alt_lines"]) and not snap["errors"]:
        return {"skipped": snap["budget"]["reason"], "credits_remaining": snap["credits_remaining"]}
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(snap))
    log(f"cfb odds: saved {len(snap['game_lines'])} game-line prices, {len(snap['team_totals'])} team-total prices and "
        f"{len(snap['props'])} prop prices; {snap['credits_remaining']} credits remaining")
    return {"saved": dest.name, "game_lines": len(snap["game_lines"]), "team_totals": len(snap["team_totals"]),
            "props": len(snap["props"]), "budget": snap["budget"], "credits_remaining": snap["credits_remaining"],
            "errors": snap["errors"]}


# --------------------------------------------------------------------------- run
def run(log=print, force_odds: bool = False, force_files: bool = False) -> dict:
    day = today_et()
    files = download_files(log=log, force=force_files)
    espn = save_espn(day, log)
    status = {"date": day, "ran_at": utcnow(), "files": files, "espn": espn, "odds": save_odds(day, log, force_odds),
              "license": sources.LICENSE_NOTE}
    arch = sources.archive_dir()
    arch.mkdir(parents=True, exist_ok=True)
    (arch / "status.json").write_text(json.dumps(status, indent=2))
    with (arch / "runs.jsonl").open("a") as f:
        f.write(json.dumps({"date": day, "ran_at": status["ran_at"],
                            "odds": {k: v for k, v in status["odds"].items() if k != "budget"}}) + "\n")
    return status


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="cfb.collect")
    ap.add_argument("--force-odds", action="store_true")
    ap.add_argument("--force-files", action="store_true")
    a = ap.parse_args(argv)
    st = run(force_odds=a.force_odds, force_files=a.force_files)
    print(json.dumps({k: st[k] for k in ("date", "espn", "odds")}, indent=2, default=str))
    failed = [f for f in st["files"] if str(f["status"]).startswith("failed") and not (sources.raw_dir() / f["file"]).exists()]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
