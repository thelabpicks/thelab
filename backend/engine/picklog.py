"""Every pick the site suggests, saved before kickoff and graded after the game.

  python -m engine.picklog      # save this week's picks, grade finished games, write data/results/live_record.json

Each publish run saves what the site is showing for the upcoming week: every anytime-TD chance and the leaning side of
every validated prop at the line shown (the main book line once prices are loaded, otherwise the player's usual line
where it sits near the projection), only for players expected to play, with its tier and whether it was featured
(Top 3 or Strong). Rows for a game are frozen at kickoff: later runs only replace rows for games that have not started,
so nothing is ever graded with hindsight. Finished games are graded against the box score (a player who did not play
is void). The report compares each tier's live hit rate with the chance the site gave and flags drift when enough
picks disagree with it; the models themselves refit on the new box scores every run.

Pick files live in FG_PICKS_DIR (default data/picks); the hosted site keeps them on the nfl-data branch.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

from . import db, odds, paths, props, status
from .backtest import wilson
from .util import utcnow

MIN_SNAP = 0.3       # same rule as the site's "who plays" filter (frontend/src/lib/playing.ts)
DRIFT_MIN_N = 100    # picks in a tier before its live record can flag drift
TD_TIERS = [("Strong", 0.50), ("Solid", 0.35), ("Lean", 0.20), ("Long shot", 0.0)]
PROP_TIERS = [("Strong", 0.65), ("Solid", 0.58), ("Lean", 0.53), ("Coin flip", 0.0)]


def picks_dir() -> Path:
    return Path(os.environ.get("FG_PICKS_DIR") or paths.data_dir() / "picks")


def week_path(season: int, week: int) -> Path:
    return picks_dir() / f"{season}-w{week:02d}.json"


def tier(kind: str, p: float) -> str:
    for name, lo in TD_TIERS if kind == "td" else PROP_TIERS:
        if p >= lo:
            return name
    return TD_TIERS[-1][0] if kind == "td" else PROP_TIERS[-1][0]


def _loads(s, default):
    try:
        return json.loads(s) if s else default
    except (TypeError, ValueError):
        return default


def _kickoffs(c, season: int, week: int) -> dict[str, datetime | None]:
    from app.routes.top3 import kickoff_utc  # noqa: PLC0415
    return {r["game_id"]: kickoff_utc(r["gameday"], r["gametime"])
            for r in c.execute("SELECT game_id, gameday, gametime FROM games WHERE season=? AND week=?", (season, week))}


def _main_lines(snap: dict | None) -> tuple[dict, set, set]:
    """Most common main (non-alternate) over line per (market, player), players with a TD price, games with TD prices."""
    counts: dict = {}
    td_players, td_games = set(), set()
    for r in (snap or {}).get("rows", []):
        if r.get("alt"):
            continue
        if r["market"] == "td":
            td_players.add(r["player_id"]); td_games.add(r["game_id"])
        elif r["side"] == "over" and r.get("line") is not None:
            k = (r["market"], r["player_id"])
            counts.setdefault(k, {}).setdefault(r["line"], 0)
            counts[k][r["line"]] += 1
    return {k: max(v, key=v.get) for k, v in counts.items()}, td_players, td_games


def _estimated_line(median: float, recent_med: float | None) -> tuple[float, str]:
    """Same rule as the site (frontend/src/lib/ask.ts estimatedLine): his recent median rounded to a half point, unless it
    sits far from this week's projection (recent games in a different role), then the projection rounded the same way."""
    projected = (max(0.5, math.floor(median) + 0.5), "projected")
    if recent_med is None:
        return projected
    line = math.floor(recent_med) + 0.5
    return projected if abs(median - line) > max(1.5, 0.2 * max(line, median)) else (line, "usual")


def collect(c, season: int, week: int) -> list[dict]:
    """The picks the site shows for the week right now."""
    from app.routes.top3 import weekly_top3  # noqa: PLC0415
    snap = odds.load_snapshot(season, week)
    main, td_priced, td_games = _main_lines(snap)
    top3 = {l["player_id"] for l in weekly_top3(season, week, [], c).get("legs", [])}
    prun = c.execute("SELECT run_id FROM prop_projections JOIN prop_runs USING(run_id) WHERE season=? AND week=? "
                     "ORDER BY created_at DESC LIMIT 1", (season, week)).fetchone()
    proj = [dict(r) for r in c.execute("SELECT * FROM prop_projections WHERE run_id=? AND eligible=1", (prun["run_id"],))] if prun else []
    # Each team's projected starting QB: the most pass attempts per game among its eligible QBs.
    starter: dict[str, tuple[float, str]] = {}
    for r in proj:
        if r["position"] == "QB" and r["market"] == "pass_attempts":
            att = _loads(r["evidence"], {}).get("attempts_pg") or 0
            if att > starter.get(r["team"], (-1, ""))[0]:
                starter[r["team"]] = (att, r["player_id"])

    def plays(pos, team, pid, snap_pct) -> bool:
        if pos == "QB":
            return team in starter and starter[team][1] == pid
        return isinstance(snap_pct, (int, float)) and snap_pct >= MIN_SNAP

    out = []
    run = c.execute("SELECT run_id FROM predictions WHERE season=? AND week=? AND p_model IS NOT NULL ORDER BY rowid DESC LIMIT 1",
                    (season, week)).fetchone()
    if run:
        for r in c.execute("SELECT * FROM predictions WHERE run_id=? AND season=? AND week=? AND eligible=1 AND p_model IS NOT NULL",
                           (run["run_id"], season, week)):
            if not r["game_id"] or not plays(r["position"], r["team"], r["player_id"], _loads(r["features"], {}).get("snap_pct")):
                continue
            if r["game_id"] in td_games and r["player_id"] not in td_priced:
                continue  # books priced this game without him: not a bet anyone can place
            p = float(r["p_model"])
            out.append({"kind": "td", "market": "td", "game_id": r["game_id"], "player_id": r["player_id"], "player_name": r["player_name"],
                        "team": r["team"], "position": r["position"], "side": "yes", "line": None, "line_source": None, "p": round(p, 4),
                        "tier": tier("td", p), "featured": r["player_id"] in top3 or p >= TD_TIERS[0][1]})
    for r in proj:
        if not r["calibrated"] or not r["dist"]:
            continue
        ev = _loads(r["evidence"], {})
        if not plays(r["position"], r["team"], r["player_id"], ev.get("snap_pct")):
            continue
        book = main.get((r["market"], r["player_id"]))
        med = ev.get(f"{props.MARKETS[r['market']]['stat']}_med")
        if book is None and snap:
            continue  # prices are loaded but no book posted this player: not a bet anyone can place
        line, source = (book, "book") if book is not None else _estimated_line(r["median"], med)
        po = odds.p_over_desc(_loads(r["dist"], {}), float(line))
        side, p = ("over", po) if po >= 0.5 else ("under", 1 - po)
        out.append({"kind": "props", "market": r["market"], "game_id": r["game_id"], "player_id": r["player_id"],
                    "player_name": r["player_name"], "team": r["team"], "position": r["position"], "side": side, "line": float(line),
                    "line_source": source, "p": round(p, 4), "tier": tier("props", p),
                    "featured": p >= PROP_TIERS[0][1],
                    # The projection itself, so the report can check how close it came, not only which side won.
                    "median": round(float(r["median"]), 2), "q10": round(float(r["q10"]), 2), "q90": round(float(r["q90"]), 2)})
    return out


def save(c, season: int, week: int, now: datetime | None = None, log=print) -> dict:
    """Merge the current picks into the week's file, keeping rows for games that have already kicked off."""
    now = now or datetime.now(timezone.utc)
    ko = _kickoffs(c, season, week)
    started = {g for g, t in ko.items() if t is not None and t <= now}
    f = week_path(season, week)
    old = json.loads(f.read_text()) if f.exists() else {"season": season, "week": week, "rows": []}
    keep = [r for r in old["rows"] if r["game_id"] in started]
    at = now.isoformat()
    new = [dict(r, saved_at=at, kickoff=ko[r["game_id"]].isoformat() if ko.get(r["game_id"]) else None)
           for r in collect(c, season, week) if r["game_id"] not in started]
    old["rows"] = keep + new
    old["updated_at"] = at
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(old))
    log(f"picklog: {season} week {week}: {len(new)} picks saved for {len({r['game_id'] for r in new})} upcoming games, "
        f"{len(keep)} frozen at kickoff")
    return old


def grade(c, rows: list[dict], season: int, week: int) -> list[dict]:
    """Attach result (1 hit, 0 miss, None void or not played yet) and the actual stat to each row of one week."""
    done = {r["game_id"] for r in c.execute("SELECT game_id FROM games WHERE season=? AND week=? AND home_score IS NOT NULL", (season, week))}
    pg = {(r["player_id"], r["game_id"]): r for r in c.execute(
        "SELECT player_id, game_id, participated, scored_anytime FROM player_game WHERE season=? AND week=?", (season, week))}
    # a final score arrives hours before the box score: until a game has player rows, its picks stay pending rather
    # than being voided as "did not play"
    stats_in = {gid for (_, gid) in pg}
    h = props.load_history(c)
    h = h[(h.season == season) & (h.week == week)].set_index("player_id")
    out = []
    for r in rows:
        g = dict(r, result=None, actual=None, status="pending")
        if r["game_id"] in done and r["game_id"] in stats_in:
            row = pg.get((r["player_id"], r["game_id"]))
            if row is None or not row["participated"]:
                g["status"] = "void"
            elif r["kind"] == "td":
                g["actual"] = int(row["scored_anytime"] or 0)
                g["result"], g["status"] = g["actual"], "graded"
            elif r["player_id"] in h.index:
                st = props.MARKETS[r["market"]]["stat"]
                v = h.loc[r["player_id"], st]
                v = float(v.iloc[0] if hasattr(v, "iloc") else v)
                g["actual"] = v
                g["result"] = int((v > r["line"]) == (r["side"] == "over"))
                g["status"] = "graded"
        out.append(g)
    return out


def _summary(rows: list[dict]) -> dict:
    n = len(rows)
    k = sum(r["result"] for r in rows)
    avg = sum(r["p"] for r in rows) / n if n else None
    ci = wilson(k, n) if n else None
    drift = None
    if n >= DRIFT_MIN_N and ci and avg is not None:
        drift = "running hot" if ci[0] > avg else "running cold" if ci[1] < avg else None
    return {"n": n, "hits": k, "rate": k / n if n else None, "avg_chance": avg, "ci": ci, "drift": drift}


def _projection_check(graded: list[dict]) -> list[dict]:
    """How close each market's projections came to what happened: typical miss, bias, and how often the 8-in-10 range held."""
    out = []
    for m in sorted({r["market"] for r in graded if r["kind"] == "props" and r.get("median") is not None}):
        sel = [r for r in graded if r["market"] == m and r.get("median") is not None and r["actual"] is not None]
        if not sel:
            continue
        err = [r["actual"] - r["median"] for r in sel]
        out.append({"market": m, "label": props.MARKETS[m]["label"], "n": len(sel),
                    "typical_miss": round(sorted(abs(e) for e in err)[len(err) // 2], 2),
                    "bias": round(sum(err) / len(err), 2),
                    "in_range": round(sum(r["q10"] <= r["actual"] <= r["q90"] for r in sel) / len(sel), 3)})
    return out


def _score_check(c, weeks: list[tuple[int, int]]) -> dict | None:
    """The betting lines the models lean on (team totals, spreads) against the final scores of the same weeks."""
    rows = []
    for season, week in weeks:
        rows += [dict(r) for r in c.execute("SELECT home_score, away_score, spread_line, total_line FROM games WHERE season=? AND week=? "
                                            "AND home_score IS NOT NULL AND total_line IS NOT NULL", (season, week))]
    if not rows:
        return None
    tot = [r["home_score"] + r["away_score"] - r["total_line"] for r in rows]
    mar = [(r["home_score"] - r["away_score"]) - (r["spread_line"] or 0) for r in rows]
    return {"games": len(rows), "total_typical_miss": round(sorted(abs(x) for x in tot)[len(tot) // 2], 1),
            "total_bias": round(sum(tot) / len(tot), 1), "overs": sum(x > 0 for x in tot),
            "margin_typical_miss": round(sorted(abs(x) for x in mar)[len(mar) // 2], 1)}


RECENT_WEEKS = 3


def _recent_rows(rows: list[dict]) -> list[dict]:
    """Every settled pick (graded or void) from the last few weeks, one small row each, so other pages (The Lab's picks)
    can grade the same bets without the database."""
    weeks = sorted({(r["season"], r["week"]) for r in rows})[-RECENT_WEEKS:]
    return [{k: r.get(k) for k in ("season", "week", "game_id", "player_id", "market", "side", "line", "status", "actual", "result")}
            for r in rows if (r["season"], r["week"]) in weeks]


PREVIOUS_WEEKS = 8


def _previous(c, rows: list[dict]) -> list[dict]:
    """Every settled pick of the last few weeks, by week and game, for the Previous weeks page: what the model said
    (side, line, chance, projection) next to what happened. Kept compact: one short list per pick.
    Pick = [player_id, name, team, market, side, line, chance, projection, actual, result (1, 0 or None for void), featured]."""
    weeks = sorted({(r["season"], r["week"]) for r in rows})[-PREVIOUS_WEEKS:]
    out = []
    for season, week in reversed(weeks):
        score = {r["game_id"]: [r["home_team"], r["away_team"], r["home_score"], r["away_score"], r["gameday"]] for r in c.execute(
            "SELECT game_id, home_team, away_team, home_score, away_score, gameday FROM games WHERE season=? AND week=?", (season, week))}
        games: dict = {}
        for r in sorted((r for r in rows if (r["season"], r["week"]) == (season, week)), key=lambda r: -r["p"]):
            games.setdefault(r["game_id"], []).append([r["player_id"], r.get("player_name"), r.get("team"), r["market"], r["side"], r.get("line"),
                                                       r["p"], r.get("median"), r.get("actual"), r.get("result"), bool(r.get("featured"))])
        gl = []
        for gid, picks in games.items():
            h, a, hs, as_, day = score.get(gid, [None, None, None, None, None])
            gl.append({"game_id": gid, "home": h, "away": a, "score": [hs, as_], "date": day,
                       "kickoff": next((r.get("kickoff") for r in rows if r["game_id"] == gid and r.get("kickoff")), None), "picks": picks})
        out.append({"season": season, "week": week, "games": sorted(gl, key=lambda g: (g["kickoff"] or g["date"] or "", g["game_id"]))})
    return out


def report(c) -> dict:
    files = sorted(picks_dir().glob("*.json")) if picks_dir().exists() else []
    weeks, graded, settled = [], [], []
    for f in files:
        w = json.loads(f.read_text())
        rows = grade(c, w["rows"], w["season"], w["week"])
        g = [r for r in rows if r["status"] == "graded"]
        settled += [dict(r, season=w["season"], week=w["week"]) for r in rows if r["status"] != "pending"]
        graded += [dict(r, season=w["season"], week=w["week"]) for r in g]
        weeks.append({"season": w["season"], "week": w["week"], "picks": len(rows), "graded": len(g),
                      "void": sum(r["status"] == "void" for r in rows), "pending": sum(r["status"] == "pending" for r in rows),
                      "featured": _summary([r for r in g if r["featured"]]), "all": _summary(g)})
    from . import gamesim, simreview  # noqa: PLC0415
    sim_review = gamesim.latest_review()
    sim_report = simreview.latest()
    recent = _recent_rows(settled)
    previous = _previous(c, settled)
    if not graded:
        return {"available": False, "created_at": utcnow(), "weeks": weeks, "sim_review": sim_review, "sim_report": sim_report, "recent_rows": recent,
                "previous_weeks": previous, "empty_reason": "Picks are saved before every kickoff starting with 2026 Week 7. The first results appear after those games are final."}
    by = lambda key: sorted({key(r) for r in graded})  # noqa: E731
    tiers = {kind: [{"tier": t, **_summary([r for r in graded if r["kind"] == kind and r["tier"] == t])}
                    for t, _ in (TD_TIERS if kind == "td" else PROP_TIERS)] for kind in ("td", "props")}
    bins = []
    for lo in range(0, 100, 10):
        sel = [r for r in graded if lo / 100 <= r["p"] < (lo + 10) / 100 or (lo == 90 and r["p"] == 1)]
        if sel:
            bins.append({"lo": lo / 100, "hi": (lo + 10) / 100, **_summary(sel)})
    last = max((r["season"], r["week"]) for r in graded)
    misses = sorted([r for r in graded if (r["season"], r["week"]) == last and r["featured"] and r["result"] == 0], key=lambda r: -r["p"])[:10]
    drift = [f"{'TD' if kind == 'td' else 'Props'} {t['tier']}: {t['drift']} ({t['hits']} of {t['n']} hit vs {t['avg_chance']:.0%} expected)"
             for kind, ts in tiers.items() for t in ts if t["drift"]]
    out = {"available": True, "created_at": utcnow(), "graded": len(graded), "overall": _summary(graded),
           "featured": _summary([r for r in graded if r["featured"]]), "tiers": tiers,
           "by_market": [{"market": m, "label": "Anytime TD" if m == "td" else props.MARKETS[m]["label"],
                          **_summary([r for r in graded if r["market"] == m])} for m in by(lambda r: r["market"])],
           "by_side": [{"side": s, **_summary([r for r in graded if r["side"] == s])} for s in by(lambda r: r["side"])],
           "calibration": bins, "weeks": weeks, "drift": drift, "drift_min_n": DRIFT_MIN_N,
           "sim_review": sim_review, "sim_report": sim_report, "recent_rows": recent, "previous_weeks": previous, "projections": _projection_check(graded), "scores": _score_check(c, sorted({(r["season"], r["week"]) for r in graded})),
           "last_week": {"season": last[0], "week": last[1], "featured_misses": [
               {k: r[k] for k in ("player_name", "team", "market", "side", "line", "p", "actual", "tier")} for r in misses]},
           "method": ["Picks are saved by every site update and frozen at each game's kickoff, so results are never graded with hindsight.",
                      "A pick is the leaning side at the line shown: the main sportsbook line once prices are loaded, otherwise the player's usual line.",
                      "Players who did not play are void and left out.",
                      f"A tier is flagged as drifting once it has {DRIFT_MIN_N}+ graded picks and its 95% interval no longer contains the chance the site gave.",
                      "Each projection is also checked against the final stat (typical miss, whether it ran high or low, how often the 8-in-10 range held), and the betting lines behind team scoring against the final scores.",
                      "Every game's simulation is frozen at kickoff too, and after the final it is run again with what really happened (who played, team volume, roles, efficiency) to show which pregame input was off.",
                      "The site refreshes before every game window (Thursday, Saturday, Sunday morning, Sunday evening, Monday) with the latest box scores, injury reports and prices, and the models refit on every new box score each run; drift flags are reviewed weekly before any adjustment is made."]}
    return out


def run(c, season: int, log=print) -> dict:
    week = status.current_week(c, season)
    if week:
        try:
            save(c, season, week, log=log)
        except Exception as ex:  # noqa: BLE001 - logging picks must never stop the site from building
            log(f"picklog: picks not saved ({ex})")
    rep = report(c)
    paths.results_dir().mkdir(parents=True, exist_ok=True)
    (paths.results_dir() / "live_record.json").write_text(json.dumps(rep, indent=2, default=float))
    if rep.get("available"):
        o = rep["overall"]
        log(f"picklog: {o['hits']} of {o['n']} graded picks hit ({o['rate']:.1%}, site gave {o['avg_chance']:.1%})")
    return rep


def latest() -> dict:
    f = paths.results_dir() / "live_record.json"
    return json.loads(f.read_text()) if f.exists() else {"available": False, "empty_reason": "No pick log yet."}


if __name__ == "__main__":
    con = db.connect(paths.db_path())
    rep = run(con, 2026)
    print(json.dumps({k: rep.get(k) for k in ("available", "graded", "overall", "drift")}, indent=2, default=float))
