"""Build every NBA number the website shows and write it as JSON.

  python -m nba.pipeline                    # writes ../site-data/nba/ (the hosted site copies it to dist/data/nba)
  python -m nba.pipeline --out DIR

Steps: load box scores -> pregame features -> walk-forward per market (cached by month) -> gate against the
player-average baseline -> confidence tiers, Due study, same-game correlation -> projections for the next slate ->
freeze today's leans in the archive (first projection of the day is kept) -> grade earlier frozen leans -> JSON.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from engine.util import utcnow

from . import collect, correlation, history, predict, props, report, sources, teamfit

SITE_ROWS_MIN_MINUTES = report.PROP_MIN_MINUTES  # books rarely list deep-bench players


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else round(f, 4)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    if isinstance(o, pd.Period):
        return str(o)
    return o


def _write(out: Path, name: str, obj) -> None:
    f = out / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(_clean(obj), separators=(",", ":")))


def results_dir() -> Path:
    return sources.data_dir() / "results"


def _norm(s: str) -> str:
    s = re.sub(r"[^a-z ]", "", s.lower().replace("-", " ").replace(".", ""))
    return " ".join(w for w in s.split() if w not in {"jr", "sr", "ii", "iii", "iv"})


# --------------------------------------------------------------------------- odds from the archive
def book_odds(day: str) -> dict:
    """Today's saved prices: game lines by team and player props by (normalized name, market)."""
    f = sources.archive_dir() / "odds" / f"{day}.json"
    espn = collect.load_espn_lines(day)
    if not f.exists():
        return {"games": espn, "props": {}, "dk": collect.load_espn_props(day), "fetched_at": None, "plan": None}
    s = json.loads(f.read_text())
    ev = {g["event_id"]: g for g in s.get("games", [])}
    games = {}
    for l in s.get("game_lines", []):
        g = ev.get(l["event_id"])
        if not g:
            continue
        k = (g["home"], g["away"])
        e = games.setdefault(k, {"totals": [], "spreads": {}})
        if l["market"] == "totals" and str(l["team"]).lower() == "over" and l["point"] is not None:
            e["totals"].append(l["point"])
        if l["market"] == "spreads" and l["team"] == g["home"] and l["point"] is not None:
            e["spreads"].setdefault("home", []).append(l["point"])
    games = {k: {"total": float(np.median(v["totals"])) if v["totals"] else None,
                 "home_spread": float(np.median(v["spreads"]["home"])) if v["spreads"].get("home") else None} for k, v in games.items()}
    games = espn | games   # bought lines when there are any, else ESPN's (DraftKings) for free
    pr: dict = {}
    for p in s.get("props", []):
        pr.setdefault((_norm(p["player"]), p["market"]), []).append(
            {"book": p["book"], "side": p["side"], "line": p["line"], "price": p["price"]})
    # DraftKings' lines for every game and market, free from ESPN: the line when no prices were bought for it
    return {"games": games, "props": pr, "dk": collect.load_espn_props(day), "fetched_at": s.get("fetched_at"),
            "plan": (s.get("budget") or {}).get("plan")}


def _consensus_line(offers: list[dict]) -> float | None:
    lines = [o["line"] for o in offers if o.get("line") is not None]
    if not lines:
        return None
    vals, counts = np.unique(lines, return_counts=True)
    return float(vals[np.argmax(counts)])


# --------------------------------------------------------------------------- pipeline
def run(out: Path, log=print, today: str | None = None) -> dict:
    today = today or collect.today_et()
    t0 = datetime.now(timezone.utc)
    d = history.load_box()
    f = history.build_features(d)
    log(f"nba: {d.game_id.nunique():,} games, {int(d.played.sum()):,} player-games, features ready")
    res_dir = results_dir()
    res_dir.mkdir(parents=True, exist_ok=True)
    oos, reports = {}, {}
    for market in props.MARKETS:
        cache = res_dir / f"wf_{market}.pkl"
        cached = pd.read_pickle(cache) if cache.exists() else None
        r = props.walk_forward(f, market, cached=cached, log=log)
        r.to_pickle(cache)
        oos[market] = r
        reports[market] = report.market_report(r, market)
        log(f"nba gate {market}: validated={reports[market]['validated']} failed={reports[market]['failed_checks']}")
    validated = {m for m, rp in reports.items() if rp["validated"]}
    conf = report.confidence(oos, validated)
    due = report.due_study(oos)
    cor = correlation.run({m: oos[m] for m in validated}, log=log) if validated else None

    # calibration for live projections: the most recent 12 months of out-of-sample predictions
    calib = {}
    for market, r in oos.items():
        recent = r[r.month.isin(sorted(r.month.unique())[-12:])]
        bands = props.fit_alpha_bands(recent.y.to_numpy(), recent.mu.to_numpy(), recent.min_l.to_numpy())
        calib[market] = {"alpha_bands": bands, "platt": props.fit_platt(recent, bands)}

    team_fit = teamfit.fit(oos["points"]) if "points" in validated else {"use": False, "reason": "points not validated"}
    log(f"nba team check: use={team_fit.get('use')} plain={team_fit.get('plain')} adjusted={team_fit.get('adjusted')}")

    sched = predict.load_schedule()
    slate = predict.next_slate(sched, today)
    proj = predict.project(d, slate, calib, log=log, team_fit=team_fit) if len(slate) else pd.DataFrame()
    odds = book_odds(today)
    # Due is shown only in markets where, in testing, such players beat their projection at least as often as others.
    due_markets = {m for m, v in due["markets"].items() if v["beat_projection"] >= v["others_beat_projection"]}
    rows = slate_json(proj, f, oos, reports, odds, due_markets) if len(proj) else []
    # Free plan: buy real prop lines for the likeliest picks' games and markets, then rebuild the rows at those lines.
    if rows and not odds["props"] and len(slate) and str(slate.game_date.min().date()) == today and props_posted():
        teams = {g.game_id: (g.home_abbreviation, g.away_abbreviation) for g in slate.itertuples()}
        got = collect.fetch_props(today, prop_targets(rows, teams), log=log)
        if got.get("prices"):
            odds = book_odds(today)
            rows = slate_json(proj, f, oos, reports, odds, due_markets)
    games = [{"game_id": g.game_id, "date": str(g.game_date.date()), "time": g.game_date_time, "home": g.home_abbreviation,
              "away": g.away_abbreviation, **odds["games"].get((g.home_abbreviation, g.away_abbreviation), {})}
             for g in slate.itertuples()]
    slate_date = str(slate.game_date.min().date()) if len(slate) else None
    frozen = freeze(slate_date, rows, tip_times(slate)) if slate_date else None
    rec = record(d)

    out.mkdir(parents=True, exist_ok=True)
    _write(out, "slate.json", {"date": slate_date, "generated_at": utcnow(), "games": games, "rows": rows,
                               "rotation": rotation_json(proj) if len(proj) else [],
                               "odds": {"fetched_at": odds["fetched_at"], "plan": odds["plan"],
                                        "props_priced": bool(odds["props"] or odds.get("dk"))}})
    _write(out, "markets.json", {"markets": list(reports.values()),
                                 "note": "Each market must beat the player-average baseline on games it never saw before over/under chances are shown."})
    _write(out, "confidence.json", conf)
    _write(out, "due.json", due)
    _write(out, "correlation.json", cor or {"use_correlation": False, "buckets": {}})
    _write(out, "previous.json", rec.pop("previous", None) or {"generated_at": utcnow(), "days": [], "note": rec.get("empty_reason")})
    _write(out, "record.json", rec)
    players = player_pages(d, rows)
    for pid, page in players.items():
        _write(out, f"players/{pid}.json", page)
    status = {"generated_at": utcnow(), "seconds": (datetime.now(timezone.utc) - t0).total_seconds(),
              "season": sources.CURRENT_SEASON, "season_label": f"{sources.CURRENT_SEASON - 1}-{str(sources.CURRENT_SEASON)[2:]}",
              "history": {"first_season": int(d.season.min()), "games": int(d.game_id.nunique()),
                          "player_games": int(d.played.sum()),
                          "last_game_date": str(d[d.played].game_date.max().date())},
              "slate_date": slate_date, "slate_games": len(games), "projected_players": len({r["player_id"] for r in rows}),
              "validated_markets": sorted(validated), "recency_half_life_seasons": props.RECENCY_HALF_LIFE,
              "team_check": {k: v for k, v in team_fit.items() if k != "fit_on_earlier"},
              "frozen": frozen, "license": sources.LICENSE_NOTE,
              "injuries_as_of": next(iter(predict.injuries().values()), {}).get("as_of")}
    _write(out, "status.json", status)
    log(f"nba: wrote site data for {slate_date} ({len(rows)} rows, {len(players)} player pages) in {status['seconds']:.0f}s")
    return status


MIN_START_RATE, MIN_MINUTES = 0.6, 24   # books post props for regular starters
MIN_PICK_GAMES = 5   # rookies are projected from their second game, but picked only once their hit rate has a base


def regular_starter(e: dict) -> bool:
    """Starts most games with starter's minutes, judged on this season once he has played in it."""
    if (e.get("start_rate") or 0) < MIN_START_RATE or (e.get("minutes") or 0) < MIN_MINUTES \
            or (e.get("career_games") or MIN_PICK_GAMES) < MIN_PICK_GAMES:
        return False
    g = e.get("season_games")
    if g is None:
        return True
    return g > 0 and (e.get("season_starts") or 0) / g >= MIN_START_RATE and (e.get("season_min") or 0) >= MIN_MINUTES


PROPS_FROM_HOUR_ET = 10   # books post most of the day's player props by mid-morning; the early run must not spend the day's one buy


def props_posted(now: datetime | None = None) -> bool:
    """True once the day's player props are reliably posted (10 am ET), so the single daily buy gets full markets."""
    return (now or datetime.now(timezone.utc)).astimezone(collect.ET).hour >= PROPS_FROM_HOUR_ET


def prop_targets(rows: list[dict], teams: dict) -> list[tuple[str, str, str]]:
    """(home, away, market) of each likely pick at a usual line, likeliest first: the props worth buying. Eligible: not
    out or listed worse than probable (as The Lab's NBA list, frontend lab.ts), a regular starter, and a usual line close
    to his projection (a book line far from it would change the pick)."""
    picks = []
    for r in rows:
        if r["line_source"] == "book" or r["p_over"] is None or r["out"] or r["game_id"] not in teams or r["line"] < 1.5:
            continue
        if r["injury"] and "probable" not in r["injury"].lower():
            continue
        if not regular_starter(r["evidence"]) or abs(r["mean"] - r["line"]) > max(1.5, 0.2 * max(r["line"], r["mean"])):
            continue
        picks.append((max(r["p_over"], 1 - r["p_over"]), (*teams[r["game_id"]], r["market"])))
    return [w for _, w in sorted(picks, key=lambda x: -x[0])]


def plausible_line(line: float, mean: float) -> bool:
    """A main prop line sits near what the player normally does; far off means a milestone or in-game bet."""
    return abs(line - mean) <= max(3.0, 0.3 * mean)


def slate_json(proj: pd.DataFrame, f: pd.DataFrame, oos: dict, reports: dict, odds: dict, due_markets: set[str]) -> list[dict]:
    played = f[f.played].sort_values("game_date")
    last = {m: played.groupby("player_id")[m].apply(lambda s: s.tail(10).tolist()[::-1]) for m in props.MARKETS}
    mins = played.groupby("player_id").minutes.apply(lambda s: s.tail(10).tolist()[::-1])
    rows = []
    for r in proj.itertuples():
        if (r.min_l or 0) < SITE_ROWS_MIN_MINUTES:
            continue
        m = r.market
        offers = odds["props"].get((_norm(r.player_name), m), [])
        dk_line = odds.get("dk", {}).get((str(int(r.player_id)), m))
        if dk_line is not None and not plausible_line(dk_line, r.mu):
            dk_line = None  # a milestone or in-game line slipped through: Curry at 2 points is never his main line
        book_line = _consensus_line(offers)
        if book_line is None:
            book_line = dk_line
        line = book_line if book_line is not None else (r.line if r.line == r.line else math.floor(r.mu) + 0.5)
        dist = r.dist
        validated = reports[m]["validated"]
        po = p_over_dist(dist, line) if validated else None
        recent = last[m].get(r.player_id, [])
        rows.append({
            "player_id": str(int(r.player_id)), "player_name": r.player_name, "team": r.team, "opp": r.opp, "pos": r.pos,
            "home": int(r.home), "headshot": r.headshot, "game_id": int(r.game_id), "injury": r.injury or None,
            "injury_note": r.injury_note or None, "out": bool(r.out), "market": m, "mean": r.mu, "q10": r.q10, "q90": r.q90,
            "line": line, "line_source": "book" if book_line is not None else "usual", "usual_line": r.line, "dk_line": dk_line,
            "dist": dist if validated else None, "p_over": po,
            "offers": [o for o in offers if o["line"] == line] if book_line is not None else [],
            "recent": recent, "recent_minutes": mins.get(r.player_id, []),
            "evidence": {"minutes": r.min_s, "minutes_long": r.min_l, "minutes_expected": _num(r.min_exp),
                         "career_games": int(r.games_prior), "per_min": getattr(r, f"{m}_pm_l"),
                         "opp_mult": getattr(r, f"opp_{m}"), "pace": r.pace, "opp_pace": r.opp_pace, "rest": r.rest,
                         "start_rate": r.start_rate, "season_games": int(r.season_games),
                         "season_starts": int(r.season_starts),
                         "season_min": None if r.season_min != r.season_min else float(r.season_min)},
            "due": bool(m in due_markets and len(recent) >= 4 and all(v < r.mu for v in recent[:4]) and (r.min_l or 0) >= 20),
        })
    return rows


def rotation_json(proj: pd.DataFrame) -> list[dict]:
    """Every projected player not ruled out, for the game simulations: the site's rows leave out players under 15
    minutes, and a team's rotation must add up to its whole game. Means are the same projections the picks use
    (conditional on playing his usual minutes, min_s); minutes_expected also counts coach's-decision DNPs as 0."""
    keep = {"points": "pts", "rebounds": "reb", "assists": "ast", "threes": "tpm"}
    p = proj[~proj.out & proj.market.isin(keep)]
    w = p.pivot_table(index=["player_id", "player_name", "team"], columns="market", values="mu").rename(columns=keep)
    info = p.drop_duplicates("player_id").set_index("player_id")[["min_s", "min_exp"]]
    out = []
    for (pid, name, team), r in w.iterrows():
        mins = info.loc[pid]
        out.append({"player_id": str(int(pid)), "player_name": name, "team": team, "minutes": _num(mins.min_s),
                    "minutes_expected": _num(mins.min_exp), **{k: _num(r.get(k)) for k in keep.values()}})
    return out


def p_over_dist(dist: dict, line: float) -> float:
    """Same rule as frontend pOver: clamp the raw tail, then the logistic recalibration."""
    k = int(math.floor(line))
    cdf = dist["cdf"]
    raw = 0.995 if k < 0 else 0.005 if k >= len(cdf) else 1 - cdf[k]
    raw = min(0.995, max(0.005, raw))
    a, b = dist.get("platt") or (1.0, 0.0)
    z = a * math.log(raw / (1 - raw)) + b
    return min(0.995, max(0.005, 1 / (1 + math.exp(-z))))


# --------------------------------------------------------------------------- frozen leans and the live record
def freeze(day: str, rows: list[dict], tips: dict | None = None, now: datetime | None = None) -> dict:
    """Save the day's leans before tip-off. A later run the same day (the pre-tip refresh with the latest injury news)
    replaces the leans of games that have not started; games already under way keep what was saved before them."""
    f = sources.archive_dir() / "picks" / f"{day}.json"
    now = now or datetime.now(timezone.utc)
    started = {gid for gid, t in (tips or {}).items() if t is not None and now >= t}
    prev = json.loads(f.read_text()) if f.exists() else None
    if prev and not tips:   # no tip times: never touch a saved day
        return {"date": day, "kept": True}
    picks = [{"player_id": r["player_id"], "player_name": r["player_name"], "team": r["team"], "game_id": r["game_id"],
              "market": r["market"], "line": r["line"], "line_source": r["line_source"], "p_over": round(r["p_over"], 4),
              "mean": round(float(r["mean"]), 2) if r.get("mean") is not None else None,
              "proj_minutes": round(float((r.get("evidence") or {}).get("minutes") or 0), 1) or None, "injury": r.get("injury"), "frozen_at": utcnow(), "offers": r["offers"]}
             for r in rows if r["p_over"] is not None and not r["out"] and r["line"] >= report.MIN_LINE and r["game_id"] not in started]
    kept = [p for p in (prev or {}).get("picks", []) if p["game_id"] in started]
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"date": day, "frozen_at": utcnow(), "picks": kept + picks}))
    return {"date": day, "kept": bool(kept), "picks": len(picks), "kept_started": len(kept), "refreshed": bool(prev)}


def tip_times(slate: pd.DataFrame) -> dict:
    out = {}
    for g in slate.itertuples():
        t = pd.to_datetime(getattr(g, "game_date_time", None), utc=True, errors="coerce")
        out[g.game_id] = None if pd.isna(t) else t.to_pydatetime()
    return out


def _decimal(american: int) -> float:
    return 1 + (american / 100 if american > 0 else 100 / -american)


def record(d: pd.DataFrame) -> dict:
    """Grade every frozen lean whose game is final: hit rate by confidence band, and flat-stake results where a book
    price was saved and our chance beat the price's implied chance by 3+ points."""
    files = sorted((sources.archive_dir() / "picks").glob("*.json"))
    rows = []
    box = d[d.played].set_index(["game_id", "player_id"])
    for fp in files:
        s = json.loads(fp.read_text())
        for p in s["picks"]:
            key = (int(float(p["game_id"])), int(float(p["player_id"])))
            if key not in box.index:
                continue
            val = float(box.loc[key, p["market"]] if p["market"] != "pra" else box.loc[key, "pra"])
            side = "over" if p["p_over"] >= 0.5 else "under"
            lean = max(p["p_over"], 1 - p["p_over"])
            won = int((val > p["line"]) == (side == "over"))
            prices = [o["price"] for o in p.get("offers", []) if o["side"] == side]
            best = max(prices, key=_decimal) if prices else None
            b = box.loc[key]
            rows.append({"date": s["date"], "market": p["market"], "side": side, "lean": lean, "won": won,
                         "player_name": p.get("player_name"), "opp": b["opp"], "home": int(b["home"]),
                         "team_score": b.get("team_score"), "opp_score": b.get("opponent_team_score"), "line_source": p.get("line_source"),
                         "best": best, "edge": lean - 1 / _decimal(best) if best else None,
                         "mean": p.get("mean"), "actual": val, "player_id": p["player_id"], "team": p["team"], "game_id": key[0],
                         "line": p["line"], "proj_minutes": p.get("proj_minutes"), "minutes": float(box.loc[key, "minutes"]),
                         "injury": p.get("injury")})
    if not rows:
        return {"days": 0, "picks": 0, "empty_reason": "The live record starts with the first slate the site projects; "
                                                        "each day's leans are frozen before tip-off and graded the next morning."}
    r = pd.DataFrame(rows)
    lean, hit = r.lean.to_numpy(), r.won.to_numpy()
    priced = r[r.edge.notna() & (r.edge > 0.03)]
    units = float(sum(_decimal(b) - 1 if w else -1 for b, w in zip(priced.best, priced.won)))
    return {"days": int(r.date.nunique()), "picks": int(len(r)), "first_date": r.date.min(), "last_date": r.date.max(),
            "tiers": report.tier_rows(lean, hit),
            "by_market": [{"market": m, "label": props.MARKETS[m], "n": int(len(g)), "rate": float(g.won.mean()),
                           "strong_n": int((g.lean >= 0.6).sum()),
                           "strong_rate": float(g[g.lean >= 0.6].won.mean()) if (g.lean >= 0.6).any() else None}
                          for m, g in r.groupby("market")],
            "vs_books": {"picks": int(len(priced)), "wins": int(priced.won.sum()), "units": units,
                         "roi": units / len(priced) if len(priced) else None},
            "projection_check": projection_check(r), "post_game": post_game_review(r, d), "graded": graded_rows(r),
            "previous": previous_days(r)}


GRADED_DAYS = 14
PREVIOUS_DAYS = 21


def _num(v):
    return None if v is None or v != v else float(v)


def previous_days(r: pd.DataFrame) -> dict:
    """Every graded lean of the last three weeks, by day and game, for the Previous days page: what the model said
    (side, line, chance, projection) next to the final stat. Kept compact: one short list per lean.
    Lean = [player_id, name, team, market, side, line, chance, projection, actual, won]."""
    days = sorted(r.date.unique())[-PREVIOUS_DAYS:]
    out = []
    for day in days:
        x = r[r.date == day]
        games = []
        for gid, gx in x.groupby("game_id"):
            h = gx[gx.home == 1]
            a = gx[gx.home == 0]
            home = h.team.iloc[0] if len(h) else a.opp.iloc[0]
            away = a.team.iloc[0] if len(a) else h.opp.iloc[0]
            ref = h.iloc[0] if len(h) else None
            score = [_num(ref.team_score), _num(ref.opp_score)] if ref is not None else \
                [_num(a.iloc[0].opp_score), _num(a.iloc[0].team_score)]
            games.append({"game_id": int(gid), "home": home, "away": away, "score": score,
                          "picks": [[str(int(float(p.player_id))), p.player_name, p.team, p.market, p.side, float(p.line), round(float(p.lean), 3),
                                     None if p.mean is None or p.mean != p.mean else round(float(p.mean), 1), float(p.actual), int(p.won)]
                                    for p in gx.sort_values("lean", ascending=False).itertuples()]})
        out.append({"date": day, "line_source": "book" if (x.line_source == "book").any() else "usual", "games": games})
    return {"generated_at": utcnow(), "days": out[::-1],
            "note": "Each day's leans are frozen before tip-off and graded from the box score the next morning. Book prop lines "
                    "need a paid odds plan, so most lines are the player's usual line (his recent median), not one a book posted."}


def graded_rows(r: pd.DataFrame) -> list[dict]:
    """The last two weeks of graded leans, one small row each (the final stat included), so other pages (The Lab's
    picks) can grade the same bets at their own line."""
    days = sorted(r.date.unique())[-GRADED_DAYS:]
    g = r[r.date.isin(days)]
    return [{"date": x.date, "game_id": int(x.game_id), "player_id": str(int(float(x.player_id))), "market": x.market,
             "line": float(x.line), "side": x.side, "actual": float(x.actual), "won": int(x.won)} for x in g.itertuples()]


def projection_check(r: pd.DataFrame) -> list[dict]:
    """Projections against what happened, per market (one row per player and market, so PRA is not counted 5 times):
    average miss, and bias (positive = players beat the projection). The models refit every day on these games; a bias
    that stays well away from 0 for weeks is the sign to look at a market."""
    r = r[r["mean"].notna()].drop_duplicates(["date", "player_id", "market"])
    out = []
    for m, g in r.groupby("market"):
        err = g.actual - g["mean"]
        recent = g[g.date >= sorted(g.date.unique())[-7:][0]]
        out.append({"market": m, "label": props.MARKETS[m], "n": int(len(g)), "avg_miss": round(float(err.abs().mean()), 2),
                    "bias": round(float(err.mean()), 2), "last7_n": int(len(recent)),
                    "last7_bias": round(float((recent.actual - recent["mean"]).mean()), 2)})
    return out


def post_game_review(r: pd.DataFrame, d: pd.DataFrame) -> dict:
    """Re-run each graded projection with what actually happened, to see which input was off.

    * Minutes: the projection scaled to the minutes he really played. The gap between that and the original projection
      is the part of the miss that came from minutes (foul trouble, a blowout, a rest night, a late scratch); the rest is
      his production per minute.
    * Misses that minutes explain: graded leans that lost but would have been right had we known his minutes.
    * Team scoring: each team's projected rotation points against the points it really scored.
    """
    r = r[r["mean"].notna() & r.proj_minutes.notna() & (r.proj_minutes > 0)].drop_duplicates(["date", "player_id", "market"]).copy()
    if r.empty:
        return {"n": 0}
    r["with_minutes"] = r["mean"] * r.minutes / r.proj_minutes
    r["minutes_part"] = r.with_minutes - r["mean"]
    r["rate_part"] = r.actual - r.with_minutes
    lost = r[r.won == 0]
    fixed = lost[(lost.with_minutes > lost.line) == (lost.actual > lost.line)]
    by_market = [{"market": m, "label": props.MARKETS[m], "n": int(len(g)),
                  "minutes_part": round(float(g.minutes_part.abs().mean()), 2), "rate_part": round(float(g.rate_part.abs().mean()), 2),
                  "minutes_bias": round(float((g.minutes - g.proj_minutes).mean()), 1)} for m, g in r.groupby("market")]
    pts = r[r.market == "points"]
    team_rows = []
    if len(pts):
        played = d[d.played]
        actual = played.groupby(["game_id", "team"]).points.sum()
        for (gid, team), g in pts.groupby(["game_id", "team"]):
            if (gid, team) in actual.index:
                team_rows.append({"proj": float(g["mean"].sum()), "actual_rotation": float(g.actual.sum()), "team_actual": float(actual[(gid, team)])})
    tr = pd.DataFrame(team_rows)
    flagged = r[r.injury.notna()]
    once = r.drop_duplicates(["date", "player_id"])   # minutes are per player-game, not per prop
    return {
        "n": int(len(r)), "lost": int(len(lost)), "lost_minutes_explain": int(len(fixed)),
        "by_market": by_market,
        "minutes": {"avg_miss": round(float((once.minutes - once.proj_minutes).abs().mean()), 1),
                    "bias": round(float((once.minutes - once.proj_minutes).mean()), 1), "players": int(len(once))},
        "team_rotation": {"games": int(len(tr)), "bias": round(float((tr.actual_rotation - tr.proj).mean()), 1),
                          "avg_miss": round(float((tr.actual_rotation - tr.proj).abs().mean()), 1)} if len(tr) else None,
        "injury_listed": {"n": int(len(flagged)), "hit": round(float(flagged.won.mean()), 3) if len(flagged) else None,
                          "minutes_bias": round(float((flagged.minutes - flagged.proj_minutes).mean()), 1) if len(flagged) else None},
        "biggest_misses": [{"date": x.date, "player_id": x.player_id, "market": x.market, "line": x.line, "projected": round(x["mean"], 1),
                            "actual": x.actual, "proj_minutes": x.proj_minutes, "minutes": x.minutes,
                            "cause": "minutes" if abs(x.minutes_part) > abs(x.rate_part) else "production"}
                           for _, x in lost.reindex((lost.actual - lost["mean"]).abs().sort_values(ascending=False).index).head(10).iterrows()],
    }


# --------------------------------------------------------------------------- player pages
def player_pages(d: pd.DataFrame, rows: list[dict]) -> dict:
    ids = {r["player_id"] for r in rows}
    d = d[d.player_id.notna()]
    played = d[d.played & d.player_id.astype("int64").astype(str).isin(ids)].sort_values("game_date")
    pages = {}
    for pid, g in played.groupby(played.player_id.astype("int64").astype(str)):
        g = g.tail(30)
        last = g.iloc[-1]
        pages[pid] = {
            "player_id": pid, "player_name": last.player_name, "team": last.team, "pos": last.pos, "headshot": last.headshot,
            "log": [{"date": str(x.game_date.date()), "opp": x.opp, "home": int(x.home), "minutes": x.minutes, "starter": int(x.starter),
                     "points": x.points, "rebounds": x.rebounds, "assists": x.assists, "threes": x.threes, "pra": x.pra}
                    for x in g.iloc[::-1].itertuples()],
            "props": [r for r in rows if r["player_id"] == pid],
        }
    return pages


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="nba.pipeline")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "site-data" / "nba"))
    ap.add_argument("--today")
    a = ap.parse_args(argv)
    run(Path(a.out), today=a.today)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
