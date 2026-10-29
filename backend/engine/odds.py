"""Sportsbook prices from The Odds API (https://the-odds-api.com), a licensed odds feed.

  ODDS_API_KEY=... python -m engine.odds            # fetch the upcoming week if no snapshot exists yet
  ODDS_API_KEY=... python -m engine.odds --force    # fetch again

Each fetch costs [markets] x [regions] credits per game (6 x 1 here, about 90-100 a week). The free plan has
500 credits a month, so the hosted site fetches once a week and keeps the snapshot between runs. Prices are
stored as published, with the time they were fetched; nothing is filled in or adjusted. Players are matched to
our players by name within the two teams of each game; unmatched names are kept and counted, never guessed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import db, paths, sources, status
from .util import utcnow

API = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl"
# our market -> feed market
MARKETS = {
    "td": "player_anytime_td",
    "receptions": "player_receptions",
    "pass_yards": "player_pass_yds",
    "pass_tds": "player_pass_tds",
    "rec_yards": "player_reception_yds",
    "rush_yards": "player_rush_yds",
}
# Six markets keep the weekly fetch inside the free plan; these are the most widely offered player props.
# Alternate lines (every line a book offers, e.g. 180+ passing yards at -1040) cost one more credit per market per game,
# which the free plan cannot carry, so they are fetched only when the key's monthly allowance shows a paid plan (or
# FG_ODDS_ALT=always). Their rows carry alt=True; hit rates then use only lines a book actually offers.
ALT_MARKETS = {
    "pass_yards": "player_pass_yds_alternate",
    "rush_yards": "player_rush_yds_alternate",
    "rec_yards": "player_reception_yds_alternate",
    "receptions": "player_receptions_alternate",
}
PAID_PLAN_MIN = 1000  # monthly allowance above this means a paid plan
BOOKS = {"draftkings": "DraftKings", "fanduel": "FanDuel", "betmgm": "BetMGM", "williamhill_us": "Caesars", "espnbet": "ESPN BET",
         "fanatics": "Fanatics", "betrivers": "BetRivers", "ballybet": "Bally Bet", "hardrockbet": "Hard Rock", "betonlineag": "BetOnline",
         "bovada": "Bovada", "mybookieag": "MyBookie", "betus": "BetUS", "lowvig": "LowVig"}
TEAMS = {"Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF", "Carolina Panthers": "CAR",
         "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL", "Denver Broncos": "DEN",
         "Detroit Lions": "DET", "Green Bay Packers": "GB", "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
         "Kansas City Chiefs": "KC", "Los Angeles Rams": "LA", "Los Angeles Chargers": "LAC", "Las Vegas Raiders": "LV", "Miami Dolphins": "MIA",
         "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG", "New York Jets": "NYJ",
         "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "Seattle Seahawks": "SEA", "San Francisco 49ers": "SF",
         "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS"}


def odds_dir() -> Path:
    return paths.data_dir() / "odds"


def snapshot_path(season: int, week: int) -> Path:
    return odds_dir() / f"{season}-w{week:02d}.json"


def load_snapshot(season: int, week: int) -> dict | None:
    p = snapshot_path(season, week)
    return json.loads(p.read_text()) if p.exists() else None


def norm_name(s: str) -> str:
    s = re.sub(r"[^a-z ]", "", s.lower().replace("-", " "))
    return " ".join(w for w in s.split() if w not in {"jr", "sr", "ii", "iii", "iv", "v"})


def _get(url: str, params: dict) -> tuple[object, dict]:
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": "fourth-and-goal"})
    from .ingest import _ssl_context  # noqa: PLC0415
    with urllib.request.urlopen(req, timeout=60, context=_ssl_context()) as r:
        return json.loads(r.read()), {k.lower(): v for k, v in r.headers.items()}


def _week_games(c: sqlite3.Connection, season: int, week: int) -> list[dict]:
    rows = c.execute("SELECT game_id, gameday, gametime, home_team, away_team, home_score FROM games WHERE season=? AND week=?",
                     (season, week)).fetchall()
    return [dict(r) for r in rows]


def _players(c: sqlite3.Connection, season: int, week: int) -> dict[tuple[str, str], tuple[str, str]]:
    """(team, normalized name) -> (player_id, name) for everyone we project this week."""
    out = {}
    for r in c.execute("SELECT DISTINCT player_id, player_name, team FROM prop_projections WHERE season=? AND week=? "
                       "UNION SELECT DISTINCT player_id, player_name, team FROM predictions WHERE season=? AND week=?",
                       (season, week, season, week)):
        out[(r["team"], norm_name(r["player_name"]))] = (r["player_id"], r["player_name"])
    return out


def p_over_desc(desc: dict, line: float) -> float:
    """P(result > line) from a published distribution (same rule as Distribution.p_over and frontend pOver)."""
    import numpy as np  # noqa: PLC0415

    from .props import p_over_from_quantiles  # noqa: PLC0415
    if desc["type"] == "nbinom":
        k = int(np.floor(line))
        raw = 0.995 if k < 0 else 0.005 if k >= len(desc["cdf"]) else 1 - desc["cdf"][k]
    else:
        raw = float(p_over_from_quantiles(np.array([desc["q"]], float), np.array([line], float))[0])
    raw = min(0.995, max(0.005, raw))
    a, b = desc.get("platt") or (1.0, 0.0)
    z = a * np.log(raw / (1 - raw)) + b
    model = float(min(0.995, max(0.005, 1 / (1 + np.exp(-z)))))
    sim = desc.get("sim")
    if not sim:
        return model
    from .gamesim import blend_p  # noqa: PLC0415
    return blend_p(model, sim, line)


def _model_chances(c: sqlite3.Connection, season: int, week: int) -> tuple[dict, dict]:
    """Our pregame chances for the week: TD p from the latest prediction run, prop distributions from the latest projection."""
    td = {}
    run = c.execute("SELECT run_id FROM predictions WHERE season=? AND week=? AND p_model IS NOT NULL "
                    "ORDER BY rowid DESC LIMIT 1", (season, week)).fetchone()
    if run:
        for r in c.execute("SELECT player_id, p_model FROM predictions WHERE run_id=? AND season=? AND week=? AND eligible=1",
                           (run["run_id"], season, week)):
            td[r["player_id"]] = r["p_model"]
    dist = {}
    prun = c.execute("SELECT run_id FROM prop_projections JOIN prop_runs USING(run_id) WHERE season=? AND week=? "
                     "ORDER BY created_at DESC LIMIT 1", (season, week)).fetchone()
    if prun:
        for r in c.execute("SELECT market, player_id, dist FROM prop_projections WHERE run_id=? AND calibrated=1 AND eligible=1",
                           (prun["run_id"],)):
            dist[(r["market"], r["player_id"])] = json.loads(r["dist"])
    return td, dist


def fetch(c: sqlite3.Connection, season: int, week: int, key: str, log=print) -> dict:
    games = _week_games(c, season, week)
    if not games:
        raise RuntimeError(f"No games for {season} week {week}")
    by_teams = {(g["home_team"], g["away_team"]): g for g in games if g["home_score"] is None}
    events, hdr = _get(f"{API}/events", {"apiKey": key})
    remaining = hdr.get("x-requests-remaining")
    allowance = float(remaining or 0) + float(hdr.get("x-requests-used") or 0)
    mode = os.environ.get("FG_ODDS_ALT", "auto").lower()
    want_alt = mode == "always" or (mode == "auto" and allowance > PAID_PLAN_MIN)
    markets = {**MARKETS, **({f"{k}_alt": v for k, v in ALT_MARKETS.items()} if want_alt else {})}
    todo = []
    for e in events:  # type: ignore[union-attr]
        h, a = TEAMS.get(e["home_team"]), TEAMS.get(e["away_team"])
        if (h, a) in by_teams:
            todo.append((e, by_teams[(h, a)]))
    cost = len(todo) * len(markets)
    log(f"odds: {len(todo)} upcoming games matched, about {cost} credits needed, {remaining} remaining"
        f"{'' if want_alt else ' (alternate lines skipped: free plan)'}")
    if remaining is not None and float(remaining) < cost:
        raise RuntimeError(f"Not enough Odds API credits left this month ({remaining} < {cost}); keeping the previous snapshot.")
    players = _players(c, season, week)
    td_p, dists = _model_chances(c, season, week)
    rows, unmatched, errors = [], {}, []
    for e, g in todo:
        try:
            data, hdr = _get(f"{API}/events/{e['id']}/odds", {"apiKey": key, "regions": "us", "oddsFormat": "american",
                                                              "markets": ",".join(markets.values())})
        except urllib.error.HTTPError as ex:
            errors.append(f"{g['game_id']}: HTTP {ex.code}")
            log(f"odds: {g['game_id']} HTTP {ex.code} {ex.read()[:200]!r}")
            continue
        remaining = hdr.get("x-requests-remaining", remaining)
        feed_to_ours = {v: k for k, v in markets.items()}
        for b in data.get("bookmakers", []):  # type: ignore[union-attr]
            book = BOOKS.get(b["key"], b.get("title", b["key"]))
            for m in b.get("markets", []):
                market = feed_to_ours.get(m["key"])
                if not market:
                    continue
                alt = market.endswith("_alt")
                market = market.removesuffix("_alt")
                for o in m.get("outcomes", []):
                    name = o.get("description") or ""
                    side = {"over": "over", "under": "under", "yes": "yes"}.get(str(o.get("name", "")).lower())
                    if not side or o.get("price") is None:
                        continue
                    team = next((t for t in (g["home_team"], g["away_team"]) if (t, norm_name(name)) in players), None)
                    if team is None:
                        unmatched[name] = unmatched.get(name, 0) + 1
                        continue
                    hit = players[(team, norm_name(name))]
                    # Our pregame chance for this exact side and line, frozen with the price so the week can be graded honestly.
                    if market == "td":
                        mp = td_p.get(hit[0])
                    elif (market, hit[0]) in dists and o.get("point") is not None:
                        po = p_over_desc(dists[(market, hit[0])], float(o["point"]))
                        mp = po if side == "over" else 1 - po
                    else:
                        mp = None
                    rows.append({"model_p": None if mp is None else round(float(mp), 4),"game_id": g["game_id"], "market": market, "player_id": hit[0], "player_name": hit[1], "team": team,
                                 "book": book, "side": side, "line": o.get("point"), "price": int(o["price"]),
                                 "updated": m.get("last_update") or b.get("last_update"), **({"alt": True} if alt else {})})
    snap = {"season": season, "week": week, "fetched_at": utcnow(), "source": "The Odds API (the-odds-api.com), US books",
            "games": len(todo), "alt_lines": want_alt, "rows": rows, "unmatched_names": len(unmatched), "errors": errors, "credits_remaining": remaining}
    if not rows and errors:
        raise RuntimeError("The odds feed returned errors for every game (player props may not be included on this plan): "
                           + "; ".join(errors[:3]))
    odds_dir().mkdir(parents=True, exist_ok=True)
    snapshot_path(season, week).write_text(json.dumps(snap))
    log(f"odds: saved {len(rows)} prices from {len({r['book'] for r in rows})} books; {len(unmatched)} names unmatched; "
        f"{remaining} credits remaining")
    return snap


def _decimal(american: int) -> float:
    return 1 + (american / 100 if american > 0 else 100 / -american)


def record(c: sqlite3.Connection, min_edge: float = 0.03) -> dict:
    """Grade every saved snapshot: for each player/market/side, take the best price, compare with our frozen chance,
    and settle against the box score. Flat 1-unit stakes on every pick where our chance beat the price's chance by min_edge
    (the same 3-point bar the home page uses)."""
    from .props import MARKETS as PROP_MARKETS, load_history  # noqa: PLC0415
    import pandas as pd  # noqa: PLC0415

    snaps = [json.loads(p.read_text()) for p in sorted(odds_dir().glob("*.json"))] if odds_dir().exists() else []
    rows = [dict(r, season=s["season"], week=s["week"]) for s in snaps for r in s["rows"] if r.get("model_p") is not None and not r.get("alt")]
    if not rows:
        return {"weeks": 0, "picks": 0, "empty_reason": "No graded price snapshots yet. The record starts with the first weekly price pull."}
    df = pd.DataFrame(rows)
    df["dec"] = df.price.map(_decimal)
    best = df.sort_values("dec").groupby(["season", "week", "market", "player_id", "side", "line"], dropna=False).tail(1).copy()
    best["implied"] = 1 / best.dec
    best["edge"] = best.model_p - best.implied
    h = load_history(c)
    pg = pd.read_sql_query("SELECT season, week, player_id, scored_anytime FROM player_game WHERE participated=1", c)
    out = []
    for r in best.itertuples():
        if r.market == "td":
            m = pg[(pg.season == r.season) & (pg.week == r.week) & (pg.player_id == r.player_id)]
            y = None if m.empty else int(m.scored_anytime.iloc[0])
        else:
            st = PROP_MARKETS[r.market]["stat"]
            m = h[(h.season == r.season) & (h.week == r.week) & (h.player_id == r.player_id)]
            y = None if m.empty or r.line is None else int((m[st].iloc[0] > r.line) == (r.side == "over"))
        out.append(y)
    best["won"] = out
    graded = best[best.won.notna()]
    picks = graded[graded.edge > min_edge]
    profit = float((picks.won * picks.dec - 1).sum()) if len(picks) else 0.0
    return {"weeks": int(graded[["season", "week"]].drop_duplicates().shape[0]), "priced_legs": int(len(graded)),
            "picks": int(len(picks)), "wins": int(picks.won.sum()) if len(picks) else 0,
            "win_rate": float(picks.won.mean()) if len(picks) else None, "avg_chance": float(picks.model_p.mean()) if len(picks) else None,
            "avg_implied": float(picks.implied.mean()) if len(picks) else None, "units": profit,
            "roi": profit / len(picks) if len(picks) else None,
            "note": "Each pick risks 1 unit at the best price found at fetch time; our chance was frozen at the same moment."}


def maybe_fetch(c: sqlite3.Connection, season: int, log=print, force: bool = False, max_age_hours: float = 30) -> dict | None:
    """Fetch the upcoming week when a key is configured and the saved snapshot is missing or stale. Never raises."""
    key = os.environ.get("ODDS_API_KEY", "").strip()
    if not key:
        log("odds: ODDS_API_KEY not set; skipping (prices can still be typed in)")
        return None
    week = status.current_week(c, season)
    if not week:
        return None
    snap = load_snapshot(season, week)
    if os.environ.get("FG_ODDS_FETCH", "true").lower() not in ("1", "true") and not force:
        log("odds: fetching is off for this run (the hosted site fetches on Saturday); " +
            (f"using snapshot from {snap['fetched_at']}" if snap else "no snapshot for this week yet"))
        return snap
    if snap and not force:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(snap["fetched_at"])
        if age < timedelta(hours=max_age_hours):
            log(f"odds: keeping snapshot from {snap['fetched_at']} ({age.total_seconds() / 3600:.0f} h old)")
            return snap
    try:
        return fetch(c, season, week, key, log)
    except Exception as ex:  # noqa: BLE001 - odds are optional; the site still builds
        log(f"odds: not updated ({ex})")
        return snap


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=sources.current_season())
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    c = db.connect(paths.db_path())
    try:
        maybe_fetch(c, a.season, force=a.force)
    finally:
        c.close()


if __name__ == "__main__":
    main()
