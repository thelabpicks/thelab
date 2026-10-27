"""Build every college football number the website shows and write it as JSON.

  python -m cfb.pipeline                    # writes ../site-data/cfb/ (the hosted site copies it to dist/data/cfb)
  python -m cfb.pipeline --out DIR

Steps: scores + closing lines -> weekly ratings -> walk-forward game model -> 5,000-game backtest of every market ->
proven tiers -> this week's lines (sportsbooks, then ESPN) -> 5,000 simulations per game -> picks only from proven
tiers -> player props for the featured games -> freeze each game's picks on game day -> grade earlier picks -> JSON.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from engine.util import utcnow

from . import collect, history, model, props, rating, report, sources

FREEZE_HOURS = 36      # a game's picks are frozen on the run before kickoff, within this many hours of it
WEEK_DAYS = 8          # look this far ahead, then keep only the current week (see this_week)


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return [_clean(v) for v in o.tolist()]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else round(f, 4)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    return o


def _write(out: Path, name: str, obj) -> None:
    f = out / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(_clean(obj), separators=(",", ":")))


def _norm(s: str) -> str:
    s = re.sub(r"[^a-z ]", "", s.lower().replace("-", " ").replace(".", "").replace("'", ""))
    return " ".join(w for w in s.split() if w not in {"jr", "sr", "ii", "iii", "iv"})


# --------------------------------------------------------------------------- this week's lines
STALE_HOURS = 36


def _hours(a: str, b: str) -> float:
    pa, pb = (datetime.fromisoformat(x.replace("Z", "+00:00")) for x in (a, b))
    return (pb - pa).total_seconds() / 3600


def book_table(offers: list[dict]) -> list[dict]:
    """Each sportsbook's spread, total and moneyline for one game (point and price), for the line-shopping table."""
    out: dict = {}
    for o in offers:
        b = out.setdefault(o["book"], {"book": o["book"]})
        key = {"spreads": "spread", "totals": "total", "h2h": "ml"}.get(o["market"])
        if key and o.get("price") is not None:
            b.setdefault(key, {})[o["side"]] = [o.get("point"), int(o["price"])]
    return sorted(out.values(), key=lambda b: b["book"])


def this_week(g: pd.DataFrame, now: pd.Timestamp) -> pd.Series:
    """Games of the current college football week that are still to be played. An eight-day look-ahead alone would
    show next Saturday's games on a Saturday, putting a team on the page twice (Iowa at Minnesota and Wisconsin at
    Iowa), so only the earliest week left in that window is kept."""
    ahead = (~g.final) & (g.date >= now - pd.Timedelta(hours=4)) & (g.date < now + pd.Timedelta(days=WEEK_DAYS))
    if not ahead.any():
        return ahead
    first = g[ahead].sort_values("date").iloc[0]
    return ahead & (g.season == first.season) & (g.season_type == first.season_type) & (g.week == first.week)


def live_lines(today: str) -> dict:
    """Per game: the consensus line from saved sportsbook prices (latest pull in the last week that priced the game),
    falling back to ESPN's posted line from today's scoreboard; every book's offer; team totals and props."""
    arch = sources.archive_dir()
    espn = {}
    sb = arch / "scoreboard" / f"{today}.json"
    if not sb.exists():
        older = sorted((arch / "scoreboard").glob("*.json")) if (arch / "scoreboard").exists() else []
        sb = older[-1] if older else None
    espn_at = None
    if sb:
        sbj = json.loads(sb.read_text())
        espn = {r["game_id"]: r for r in collect.parse_scoreboard(sbj)}
        espn_at = sbj.get("fetched_at")
    books: dict = {}
    tts: dict = {}
    prs: dict = {}
    alts: dict = {}
    fetched: dict = {}
    day = datetime.fromisoformat(today)
    for i in range(6, -1, -1):
        f = arch / "odds" / f"{day - timedelta(days=i):%Y-%m-%d}.json"
        if not f.exists():
            continue
        s = json.loads(f.read_text())
        got: dict = {}
        for l in s.get("game_lines", []):
            got.setdefault(l["game_id"], []).append(l)
        for gid, ls in got.items():       # a later pull replaces an earlier one game by game
            books[gid] = ls
            fetched[gid] = s.get("fetched_at")
        for t in s.get("team_totals", []):
            tts.setdefault(t["game_id"], []).append(t)
        for p in s.get("props", []):
            prs.setdefault(p["game_id"], []).append(p)
        got = {}
        for l in s.get("alt_lines", []):
            got.setdefault(l["game_id"], []).append(l)
        alts.update(got)
    out = {}
    for gid in set(espn) | set(books):
        e = espn.get(gid, {})
        ls = books.get(gid, [])
        sp = [l["point"] for l in ls if l["market"] == "spreads" and l["side"] == "home" and l["point"] is not None]
        tot = [l["point"] for l in ls if l["market"] == "totals" and l["side"] == "over" and l["point"] is not None]
        ml = {s: [l for l in ls if l["market"] == "h2h" and l["side"] == s and l["price"] is not None] for s in ("home", "away")}
        mlp = {s: float(history.american(np.median(history.implied(np.array([l["price"] for l in v], float)))))
               if v else None for s, v in ml.items()}
        # the sportsbook consensus is used while fresh; once it is older than STALE_HOURS, today's ESPN line (a real
        # book, ESPN BET, read free every day) is the current number and the older book prices stay for reference
        stale = bool(fetched.get(gid) and espn_at and _hours(fetched[gid], espn_at) > STALE_HOURS)
        use_books = bool(sp or tot) and not (stale and (e.get("home_spread") is not None or e.get("total") is not None))
        espn_src = (f"ESPN ({e['provider']})" if e.get("provider") else "ESPN") if e.get("home_spread") is not None or e.get("total") is not None else None
        row = {
            "spread": float(np.median(sp)) if sp and use_books else e.get("home_spread") if e.get("home_spread") is not None else (float(np.median(sp)) if sp else None),
            "total": float(np.median(tot)) if tot and use_books else e.get("total") if e.get("total") is not None else (float(np.median(tot)) if tot else None),
            "ml_home": mlp["home"] if mlp["home"] is not None and use_books else e.get("ml_home") if e.get("ml_home") is not None
            else None if stale else mlp["home"],
            "ml_away": mlp["away"] if mlp["away"] is not None and use_books else e.get("ml_away") if e.get("ml_away") is not None
            else None if stale else mlp["away"],
            "source": f"{len({l['book'] for l in ls})} sportsbooks" if use_books else espn_src,
            "fetched_at": fetched.get(gid) if use_books else (espn_at or fetched.get(gid)),
            "books_at": fetched.get(gid),
            # once the book prices are stale they stay in the line-shopping table but are never quoted as a pick's price
            "books_stale": stale and not use_books,
            "offers": ls, "team_totals": tts.get(gid, []), "props": prs.get(gid, []), "alts": alts.get(gid, []),
            "home_rank": e.get("home_rank"), "away_rank": e.get("away_rank"), "tv": e.get("tv"),
            "espn_spread": e.get("home_spread"), "espn_home_id": e.get("home_id"), "espn_away_id": e.get("away_id"),
        }
        out[gid] = row
    return out


ALT_MIN_CHANCE = 0.6
ALT_MAX_PRICE = -1000   # past about -1000 a book's alternate line pays almost nothing


def alt_rows(offers: list[dict], margin: np.ndarray, pts: np.ndarray, calib: dict) -> list[dict]:
    """Every alternate spread and total the books post for one game, priced by its 5,000 simulated scores: the best
    price per line, the sim's chance, the book's implied chance, and how sims at that chance did at moved lines in
    testing. Only lines at ALT_MIN_CHANCE+ and priced no shorter than ALT_MAX_PRICE are kept, likeliest first."""
    best: dict = {}
    for o in offers:
        k = (o["market"], o["side"], float(o["point"]))
        if k not in best or history.decimal(np.array([o["price"]]))[0] > history.decimal(np.array([best[k]["price"]]))[0]:
            best[k] = o
    out = []
    for (market, side, point), o in best.items():
        if market == "spreads" and side in ("home", "away"):
            x, line, over, mk = margin, -point if side == "home" else point, side == "home", "spread"
        elif market == "totals" and side in ("over", "under"):
            x, line, over, mk = pts, point, side == "over", "total"
        else:
            continue
        p = float(report.side_chance(x[None, :], np.array([line]), np.array([over]))[0])
        if not np.isfinite(p) or p < ALT_MIN_CHANCE or o["price"] < ALT_MAX_PRICE:
            continue
        t = tier_of(calib.get(mk, []), p)
        out.append({"market": mk, "side": side, "line": point, "price": int(o["price"]), "book": o["book"], "chance": p,
                    "implied": float(history.implied(np.array([o["price"]], float))[0]),
                    "tested_rate": t["rate"] if t else None, "tested_n": t["n"] if t else None,
                    "tested_recent": t["recent_rate"] if t else None})
    return sorted(out, key=lambda r: -r["chance"])


def _best(offers: list[dict], **match) -> dict | None:
    best = None
    for o in offers:
        if all(o.get(k) == v for k, v in match.items()) and o.get("price") is not None:
            if best is None or history.decimal(np.array([o["price"]]))[0] > history.decimal(np.array([best["price"]]))[0]:
                best = o
    return {"price": int(best["price"]), "book": best["book"]} if best else None


# --------------------------------------------------------------------------- picks for the week
def tier_of(tiers: list[dict], p: float, key: str = "p") -> dict | None:
    for t in tiers:
        if t["lo"] <= p < (t["hi"] if t["hi"] < 1 else 99):
            return t
    return None


PARLAY_SIMS = 1000   # simulated scores per game shipped to the parlay builder (same-game legs are priced from them)


def _b36(v: np.ndarray) -> str:
    d = "0123456789abcdefghijklmnopqrstuvwxyz"
    v = np.clip(v.astype(int), 0, 36 * 36 - 1)
    return "".join(d[x // 36] + d[x % 36] for x in v)


def sim_strings(up: pd.DataFrame, h: np.ndarray, a: np.ndarray) -> dict:
    """The first PARLAY_SIMS simulated scores of each game with a line, home then away, two base-36 digits each."""
    return {str(int(gid)): _b36(h[i, :PARLAY_SIMS]) + _b36(a[i, :PARLAY_SIMS])
            for i, gid in enumerate(up.game_id) if up.spread.iloc[i] == up.spread.iloc[i]}


UNPROVEN_CAP = 6.9   # a lean from a market or tier that did not beat the price in testing never rates 7+


def score_lean(m: dict, rater: dict | None, market: str | None = None) -> dict:
    """The Lab rating out of 10 (rating.py): the simulated chance, calibrated on how similar leans did, priced at the
    best odds on offer. Without a rater (no backtest), the plain chance x 10."""
    if rater is None:
        m["score"] = round(m["p"] * 10, 1)
        return m
    price = (m.get("best") or {}).get("price") or m.get("price")
    dec = float(history.decimal(np.array([price]))[0]) if price else None
    r = rating.rate(rater, market or m["market"], m["p"], dec, m.get("market_p", 0.5))
    m.update(r)
    m["score"] = r["rating"] if m["proven"] else min(r["rating"], UNPROVEN_CAP)
    return m


def game_rows(up: pd.DataFrame, ch: dict, summary: dict, lines: dict, qb: dict | None = None, rater: dict | None = None) -> list[dict]:
    mk = summary["markets"]
    qb = qb or {}
    rows = []
    for i, g in enumerate(up.itertuples()):
        L = lines.get(g.game_id, {})
        offers = [] if L.get("books_stale") else L.get("offers", [])
        markets = []
        if g.spread == g.spread:
            p = float(ch["p_home_cover"][i])
            home = p >= 0.5
            line = g.spread if home else -g.spread
            t = tier_of(mk["spread"]["tiers"], max(p, 1 - p))
            markets.append({"market": "spread", "side": "home" if home else "away", "team": g.home_team if home else g.away_team,
                            "line": line, "p": max(p, 1 - p), "push": float(ch["push_spread"][i]), "tier": t["tier"] if t else None,
                            "proven": bool(t and t["proven"]),
                            "best": _best(offers, market="spreads", side="home" if home else "away", point=line)})
        if g.total == g.total:
            p = float(ch["p_over"][i])
            over = p >= 0.5
            t = tier_of(mk["total"]["tiers"], max(p, 1 - p))
            markets.append({"market": "total", "side": "over" if over else "under", "line": g.total, "p": max(p, 1 - p),
                            "push": float(ch["push_total"][i]), "tier": t["tier"] if t else None, "proven": bool(t and t["proven"]),
                            "best": _best(offers, market="totals", side="over" if over else "under", point=g.total)})
        for side, team in (("home", g.home_team), ("away", g.away_team)):
            line = getattr(g, f"tt_{side}")
            if line != line:
                continue
            p = float(ch[f"p_{side}_tt_over"][i])
            over = p >= 0.5
            posted = bool(getattr(g, f"tt_{side}_posted"))
            t = tier_of(mk["team_total"]["tiers"], max(p, 1 - p))
            tto = [o for o in L.get("team_totals", []) if o["team"] == side]
            markets.append({"market": "team_total", "team": team, "team_side": side, "side": "over" if over else "under",
                            "line": line, "line_posted": posted, "p": max(p, 1 - p), "tier": t["tier"] if t else None,
                            # hit rates count only lines books actually post, so implied team totals are never picks
                            "proven": bool(t and t["proven"] and posted),
                            "best": _best([{**o, "market": "tt"} for o in tto], market="tt", side="over" if over else "under", line=line)})
        if g.ml_home == g.ml_home and g.ml_away == g.ml_away:
            ph = float(ch["p_home_win"][i])
            bh = _best(offers, market="h2h", side="home") or {"price": int(g.ml_home), "book": None}
            ba = _best(offers, market="h2h", side="away") or {"price": int(g.ml_away), "book": None}
            evh = ph * history.decimal(np.array([bh["price"]]))[0] - 1
            eva = (1 - ph) * history.decimal(np.array([ba["price"]]))[0] - 1
            home = evh >= eva
            ev = max(evh, eva)
            price = bh["price"] if home else ba["price"]
            t = tier_of(mk["moneyline"]["tiers"], ev) if ev > 0 else None
            # proven on underdogs only: favorite value bets returned +1% over 159 bets, not enough to call an edge
            in_range = 100 <= price <= report.ML_PRICE_RANGE[1]
            ih, ia = history.implied(np.array([g.ml_home, g.ml_away], float))
            markets.append({"market": "moneyline", "side": "home" if home else "away", "team": g.home_team if home else g.away_team,
                            "p": ph if home else 1 - ph, "market_p": float((ih if home else ia) / (ih + ia)),
                            "price": price, "ev": ev, "tier": t["tier"] if t else None,
                            "proven": bool(t and t["proven"] and in_range), "best": bh if home else ba})
        for m in markets:
            score_lean(m, rater)
        upset = None
        if g.ml_home == g.ml_home and g.ml_away == g.ml_away:
            ih, ia = history.implied(np.array([g.ml_home, g.ml_away], float))
            fair_h = ih / (ih + ia)
            dog_home = fair_h < 0.5
            ph = float(ch["p_home_win"][i])
            ml = next((m for m in markets if m["market"] == "moneyline"), None)
            upset = {"team": g.home_team if dog_home else g.away_team, "side": "home" if dog_home else "away",
                     "p": ph if dog_home else 1 - ph, "market": fair_h if dog_home else 1 - fair_h,
                     "price": int(g.ml_home if dog_home else g.ml_away),
                     "pick": bool(ml and ml["proven"] and ml["side"] == ("home" if dog_home else "away"))}
        elif g.spread == g.spread and g.spread != 0:
            dog_home = g.spread > 0
            ph = float(ch["p_home_win"][i])
            upset = {"team": g.home_team if dog_home else g.away_team, "side": "home" if dog_home else "away",
                     "p": ph if dog_home else 1 - ph, "market": None, "price": None, "pick": False}
        rows.append({
            "game_id": int(g.game_id), "date": g.date.isoformat() + "Z", "week": int(g.week), "season_type": g.season_type,
            "home": g.home_team, "away": g.away_team, "home_id": int(g.home_id), "away_id": int(g.away_id),
            "home_conf": g.home_conference, "away_conf": g.away_conference, "neutral": bool(g.neutral),
            "conference_game": bool(g.conference_game), "venue": g.venue if isinstance(g.venue, str) else None,
            "home_rank": L.get("home_rank"), "away_rank": L.get("away_rank"), "tv": L.get("tv"), "featured": bool(g.featured),
            "line": {"spread": g.spread, "total": g.total, "ml_home": g.ml_home, "ml_away": g.ml_away,
                     "tt_home": g.tt_home, "tt_away": g.tt_away, "tt_posted": bool(g.tt_home_posted or g.tt_away_posted),
                     "source": L.get("source"), "fetched_at": L.get("fetched_at"), "books_at": L.get("books_at"),
                     "has_line": bool(g.spread == g.spread)},
            "books": book_table(offers),
            "model": {"home": float(ch["home_mean"][i]), "away": float(ch["away_mean"][i]), "margin": float(g.pred_margin),
                      "total": float(g.pred_total), "margin_q": ch["margin_q"][i], "total_q": ch["total_q"][i],
                      "home_win": float(ch["p_home_win"][i]), "line_based": bool(g.spread == g.spread)},
            "ratings": {"home": _team_rating(g, "home"), "away": _team_rating(g, "away")},
            "markets": markets, "upset": upset,
            "notes": [f"Quarterback change? {team}'s last game was led by {qb[tid]['last_game']}, not season leader "
                      f"{qb[tid]['season_leader']}. Ratings lean on earlier games, so check the starter before betting."
                      for tid, team in ((int(g.home_id), g.home_team), (int(g.away_id), g.away_team)) if tid in qb],
        })
    return rows


def _team_rating(g, side: str) -> dict:
    return {"pts_for": getattr(g, f"r_{side}"), "ypp": getattr(g, f"y_{side}", None), "plays": getattr(g, f"n_{side}", None),
            "epa": getattr(g, f"e_{side}", None), "success": getattr(g, f"s_{side}", None), "turnovers": getattr(g, f"t_{side}", None),
            "explosive": getattr(g, f"x_{side}", None), "games": getattr(g, f"{side}_games", None)}


def reasons(row: dict, m: dict) -> list[str]:
    """Plain-language reasons for a lean, from the numbers the model published."""
    md = row["model"]
    out = []
    if m["market"] == "spread":
        fav = row["home"] if row["line"]["spread"] < 0 else row["away"]
        exp = md["margin"]
        out.append(f"Model margin: {row['home'] if exp >= 0 else row['away']} by {abs(exp):.1f}; "
                   f"the line has {fav} by {abs(row['line']['spread']):.1f}.")
    elif m["market"] == "total":
        out.append(f"Model total {md['total']:.1f} vs the line {row['line']['total']}; 80% of simulated games land "
                   f"between {md['total_q'][0]:.0f} and {md['total_q'][2]:.0f}.")
        if row["line"]["total"] >= 65:
            out.append("Totals of 65+ have gone under about 54% of the time in both 2014-21 and 2022-26.")
        if row["neutral"]:
            out.append("Neutral-site games have gone under more often than not in both eras tested.")
    elif m["market"] == "team_total":
        exp = md["home"] if m["team_side"] == "home" else md["away"]
        out.append(f"Model has {m['team']} scoring {exp:.1f}; the {'posted' if m['line_posted'] else 'implied'} team total is {m['line']}.")
    elif m["market"] == "moneyline":
        out.append(f"{m['team']} wins {m['p'] * 100:.0f}% of 5,000 simulated games; at {m['price']:+d} that is "
                   f"{m['ev'] * 100:+.1f} cents per dollar.")
        r = row["ratings"]["home" if m["side"] == "home" else "away"]
        o = row["ratings"]["away" if m["side"] == "home" else "home"]
        if r.get("epa") is not None and o.get("epa") is not None and r["epa"] > o["epa"]:
            out.append(f"{m['team']} has the better opponent-adjusted offense by EPA per play ({r['epa']:+.2f} vs {o['epa']:+.2f}).")
        if m["price"] > 0:
            out.append("Underdog value bets like this returned about 4 cents per dollar since 2016, with losing seasons mixed in.")
    return out


# --------------------------------------------------------------------------- frozen picks and the live record
def freeze(rows: list[dict], now: datetime, props_rows: list[dict] | None = None) -> dict:
    """Save each game's leans, projected score and player-prop projections on every run within FREEZE_HOURS of
    kickoff, so the file ends up holding the last run before kickoff: the picks the site showed when the game
    started. Once the game has started nothing touches it, so the report card compares what we said beforehand."""
    by_game: dict = {}
    for p in props_rows or []:
        by_game.setdefault(p["game_id"], []).append({k: p[k] for k in ("player", "player_id", "team", "market", "mean", "line",
                                                                         "line_source", "p_over", "side", "p", "tier", "proven")})
    d = sources.archive_dir() / "picks"
    d.mkdir(parents=True, exist_ok=True)
    frozen = 0
    for r in rows:
        ko = datetime.fromisoformat(r["date"].replace("Z", "+00:00"))
        if not (now < ko <= now + timedelta(hours=FREEZE_HOURS)) or not r["line"]["has_line"]:
            continue
        f = d / f"{r['game_id']}.json"
        f.write_text(json.dumps(_clean({"game_id": r["game_id"], "date": r["date"], "home": r["home"], "away": r["away"],
                                        "frozen_at": utcnow(), "line": r["line"], "featured": r["featured"],
                                        "model": r["model"], "ratings": r.get("ratings"), "notes": r.get("notes", []), "markets": r["markets"],
                                        "props": by_game.get(r["game_id"], [])})))
        frozen += 1
    return {"frozen": frozen}


def record(g: pd.DataFrame, summary: dict) -> dict:
    """Grade every frozen pick whose game is final, by market and tier, at the line it was frozen with."""
    files = sorted((sources.archive_dir() / "picks").glob("*.json")) if (sources.archive_dir() / "picks").exists() else []
    fin = g[g.final].set_index("game_id")
    rows = []
    for fp in files:
        s = json.loads(fp.read_text())
        gid = int(s["game_id"])
        if gid not in fin.index:
            continue
        x = fin.loc[gid]
        hp, ap = float(x.home_points), float(x.away_points)
        for m in s["markets"]:
            if m["market"] == "spread":
                diff = (hp - ap) + m["line"] if m["side"] == "home" else (ap - hp) + m["line"]
            elif m["market"] == "total":
                diff = (hp + ap - m["line"]) * (1 if m["side"] == "over" else -1)
            elif m["market"] == "team_total":
                pts = hp if m["team_side"] == "home" else ap
                diff = (pts - m["line"]) * (1 if m["side"] == "over" else -1)
            else:
                diff = (hp - ap) * (1 if m["side"] == "home" else -1)
            if diff == 0:
                continue
            won = int(diff > 0)
            ret = None
            if m["market"] == "moneyline":
                ret = won * float(history.decimal(np.array([m["price"]]))[0]) - 1
            rows.append({"game_id": gid, "date": s["date"][:10], "market": m["market"], "tier": m.get("tier"),
                         "proven": bool(m.get("proven")), "p": m["p"], "won": won, "ret": ret,
                         "label": f"{s['away']} at {s['home']}", "side": m.get("team") or m["side"], "line": m.get("line"),
                         "posted": m.get("line_posted", True)})
    if not rows:
        return {"games": 0, "picks": 0, "finals": recent_finals(fin), "empty_reason": "The live record starts with this week's games: every game's leans "
                                                         "are frozen on game day before kickoff and graded once the final is in."}
    r = pd.DataFrame(rows)
    by = []
    for (mkt, tier), x in r.groupby(["market", "tier"], dropna=False):
        by.append({"market": mkt, "tier": tier, "n": int(len(x)), "hits": int(x.won.sum()), "rate": float(x.won.mean()),
                   "roi": float(x.ret.mean()) if mkt == "moneyline" and x.ret.notna().any() else None})
    pk = r[r.proven]
    return {"games": int(r.game_id.nunique()), "picks": int(len(r)), "first_date": r.date.min(), "last_date": r.date.max(),
            "by_market_tier": by,
            "suggested": {"n": int(len(pk)), "hits": int(pk.won.sum()), "rate": float(pk.won.mean()) if len(pk) else None},
            "recent": r[r.proven].sort_values("date", ascending=False).head(40).to_dict("records"),
            "finals": recent_finals(fin)}


def recent_finals(fin: pd.DataFrame, days: int = 21) -> dict:
    """Final scores of every game in the last three weeks, so other pages (The Lab's picks) grade at their own line,
    including games the site's own record never froze a pick on."""
    if fin.empty:
        return {}
    last = fin[fin.date >= fin.date.max() - pd.Timedelta(days=days)]
    return {str(gid): [float(x.home_points), float(x.away_points)] for gid, x in last.iterrows()}


# --------------------------------------------------------------------------- previous weeks, game by game
def _result(diff: float) -> str:
    return "push" if diff == 0 else "won" if diff > 0 else "lost"


def _prev_lean(market: str, side: str, line, p: float, rater: dict | None, mk: dict, dec=None, q: float = 0.5, **extra) -> dict:
    m = {"market": market, "side": side, "line": line, "p": round(float(p), 4), **extra}
    if market == "moneyline":
        t = tier_of(mk["moneyline"]["tiers"], extra["ev"]) if extra["ev"] > 0 else None
        proven = bool(t and t["proven"] and 100 <= extra["price"] <= report.ML_PRICE_RANGE[1])
    else:
        t = tier_of(mk[market]["tiers"], p)
        proven = bool(t and t["proven"] and extra.get("line_posted", True))
    m.update(tier=t["tier"] if t else None, proven=proven)
    if rater is not None:
        r = rating.rate(rater, market, p, dec, q)
        m["score"] = r["rating"] if proven else min(r["rating"], UNPROVEN_CAP)
    else:
        m["score"] = round(p * 10, 1)
    return m


def _grade(m: dict, hp: float, ap: float) -> dict:
    if m["market"] == "spread":
        diff = (hp - ap) + m["line"] if m["side"] == "home" else (ap - hp) + m["line"]
    elif m["market"] == "total":
        diff = (hp + ap - m["line"]) * (1 if m["side"] == "over" else -1)
    elif m["market"] == "team_total":
        diff = ((hp if m["team_side"] == "home" else ap) - m["line"]) * (1 if m["side"] == "over" else -1)
    else:
        diff = (hp - ap) * (1 if m["side"] == "home" else -1)
    return {**m, "result": _result(diff)}


def previous_weeks(g: pd.DataFrame, bt: pd.DataFrame, summary: dict, rater: dict | None, season: int) -> dict:
    """Every finished game of the season with the model's side in every market and whether it hit, so the site can be
    checked game by game, not only on its top picks. Games frozen before kickoff use exactly what the site showed then;
    earlier games use the walk-forward backtest (the model as it stood that week, at the closing line, median across
    books). Team totals are graded only where a book posted the line: implied team totals are never counted."""
    mk = summary["markets"]
    fin = g[g.final & (g.season == season)].set_index("game_id")
    b = bt[bt.season == season] if len(bt) else bt
    sim = {int(x.game_id): {"home": float(x.pred_home), "away": float(x.pred_away), "home_win": float(x.p_home_win)} for x in b.itertuples()}
    games: dict[int, dict] = {}
    d = sources.archive_dir() / "picks"
    for fp in sorted(d.glob("*.json")) if d.exists() else []:
        s = json.loads(fp.read_text())
        gid = int(s["game_id"])
        if gid not in fin.index:
            continue
        x = fin.loc[gid]
        hp, ap = float(x.home_points), float(x.away_points)
        ms = [_grade({k: m.get(k) for k in ("market", "side", "team", "team_side", "line", "line_posted", "price", "p", "score", "tier", "proven")
                      if m.get(k) is not None}, hp, ap)
              for m in s["markets"] if m["market"] != "team_total" or m.get("line_posted")]
        L, md = s["line"], s.get("model")   # the first frozen games did not save the projected score
        games[gid] = {"game_id": gid, "week": int(x.week), "season_type": x.season_type, "date": s["date"], "home": s["home"], "away": s["away"],
                      "score": [hp, ap], "source": "live", "line": {k: L.get(k) for k in ("spread", "total", "ml_home", "ml_away")},
                      "model": {"home": md["home"], "away": md["away"], "home_win": md["home_win"]} if md else sim.get(gid), "markets": ms}
    for x in b.itertuples():
        gid = int(x.game_id)
        if gid in games or gid not in fin.index:
            continue
        hp, ap = float(x.home_points), float(x.away_points)
        ms = []
        if x.spread == x.spread:
            pc = float(x.p_home_cover)
            home = pc >= 0.5
            ms.append(_prev_lean("spread", "home" if home else "away", float(x.spread if home else -x.spread), max(pc, 1 - pc), rater, mk,
                                 team=x.home_team if home else x.away_team))
        if x.total == x.total:
            po = float(x.p_over)
            ms.append(_prev_lean("total", "over" if po >= 0.5 else "under", float(x.total), max(po, 1 - po), rater, mk))
        if x.ml_home == x.ml_home and x.ml_away == x.ml_away:
            ph = float(x.p_home_win)
            dh, da = history.decimal(np.array([x.ml_home, x.ml_away], float))
            evh, eva = ph * dh - 1, (1 - ph) * da - 1
            home = evh >= eva
            ih, ia = history.implied(np.array([x.ml_home, x.ml_away], float))
            ms.append(_prev_lean("moneyline", "home" if home else "away", None, ph if home else 1 - ph, rater, mk,
                                 dec=float(dh if home else da), q=float((ih if home else ia) / (ih + ia)),
                                 team=x.home_team if home else x.away_team, price=int(x.ml_home if home else x.ml_away),
                                 ev=round(float(max(evh, eva)), 4)))
        if not ms:
            continue
        games[gid] = {"game_id": gid, "week": int(x.week), "season_type": x.season_type, "date": x.date.isoformat() + "Z",
                      "home": x.home_team, "away": x.away_team, "score": [hp, ap], "source": "backtest",
                      "line": {"spread": x.spread, "total": x.total, "ml_home": x.ml_home, "ml_away": x.ml_away},
                      "model": sim[gid], "markets": [_grade(m, hp, ap) for m in ms]}
    rows = sorted(games.values(), key=lambda r: (r["date"], r["game_id"]))
    return {"generated_at": utcnow(), "season": season, "games": rows,
            "note": "Games frozen before kickoff show exactly what the site said then. Earlier games show the model as it stood "
                    "that week (refit on earlier games only), graded at the closing line. Team totals count only where a book posted the line."}


INPUT_LABELS = {"plays": ("plays", "Pace (plays)"), "ypp": ("ypp", "Yards per play"), "turnovers": ("to", "Turnovers"),
                "epa": ("epa", "EPA per play"), "success": ("sr", "Success rate"), "explosive": ("expl", "Explosive-play rate")}


def report_card(g: pd.DataFrame, pg: pd.DataFrame, box=None, pool: np.ndarray | None = None) -> dict:
    """After the games: how far the frozen projections were from what happened, next to how far the book's line
    was. Scores (margin, total) and player props. The weekly refits learn from the same results automatically
    (every new final joins the ratings and the model's training data); this card is how we watch that working."""
    files = sorted((sources.archive_dir() / "picks").glob("*.json")) if (sources.archive_dir() / "picks").exists() else []
    fin = g[g.final].set_index("game_id")
    games, prow = [], []
    actual = {}
    if not pg.empty:
        for r in pg.itertuples():
            actual[(int(r.game_id), str(int(r.athlete_id)))] = r
    for fp in files:
        s = json.loads(fp.read_text())
        gid = int(s["game_id"])
        if gid not in fin.index or not s.get("model"):
            continue
        x = fin.loc[gid]
        margin, total = float(x.home_points - x.away_points), float(x.home_points + x.away_points)
        ln = s["line"]
        row = {"game_id": gid, "date": s["date"][:10], "label": f"{s['away']} at {s['home']}",
               "model_margin": s["model"]["margin"], "line_margin": -ln["spread"] if ln.get("spread") is not None else None,
               "margin": margin, "model_total": s["model"]["total"], "line_total": ln.get("total"), "total": total}
        # pregame expectation of each input vs what the game produced
        for key, (stat, _) in INPUT_LABELS.items():
            for side in ("home", "away"):
                pre = (s.get("ratings") or {}).get(side, {}).get(key)
                act = x.get(f"{side}_{stat}")
                if pre is not None and act == act and act is not None:
                    row[f"err_{key}_{side}"] = float(act) - float(pre)
        ml = next((m for m in s.get("markets", []) if m.get("market") == "moneyline"), None)
        if ln.get("spread") is not None and abs(ln["spread"]) >= report.UPSET_LINE:
            dog_home = ln["spread"] > 0
            if (margin > 0) == dog_home and margin != 0:      # the underdog won
                sg = 1 if dog_home else -1
                edges = {}
                for col, label, sign in report.DRIVERS:
                    h, a = x.get(f"home_{col}"), x.get(f"away_{col}")
                    if h == h and a == a and h is not None and a is not None:
                        edges[label] = round(float(sign * sg * (h - a)), 3)
                row["upset"] = {"dog": s["home"] if dog_home else s["away"], "line": abs(ln["spread"]),
                                "model_dog_win": round(float(s["model"]["home_win"] if dog_home else 1 - s["model"]["home_win"]), 3),
                                "model_edge": round(float(sg * (s["model"]["margin"] + ln["spread"])), 1),
                                "rated": (ml["score"] if ml and ml.get("side") == ("home" if dog_home else "away") else None),
                                "edges": edges}
        games.append(row)
        for p in s.get("props", []):
            a = actual.get((gid, str(p["player_id"])))
            if a is None:
                continue
            y = float(getattr(a, p["market"]))
            prow.append({"market": p["market"], "mean": p["mean"], "line": p["line"], "line_source": p["line_source"], "y": y,
                         "hit": int((y > p["line"]) == (p["side"] == "over")) if y != p["line"] else None})
    if not games:
        return {"games": 0, "note": "Fills in after the first graded week: each game's frozen projection next to the final."}
    d = pd.DataFrame(games)
    resim = None
    if box is not None and pool is not None:
        pgm = model.postgame(box, fin.loc[d.game_id].reset_index(), pool)
        if len(pgm):
            d = d.merge(pgm[["game_id", "post_margin", "post_total"]], on="game_id", how="left")
            k = d[d.post_total.notna()]
            resim = {"games": int(len(k)),
                     "total_input_miss": float((k.post_total - k.model_total).abs().mean()),
                     "total_rest_miss": float((k.total - k.post_total).abs().mean()),
                     "margin_input_miss": float((k.post_margin - k.model_margin).abs().mean()),
                     "margin_rest_miss": float((k.margin - k.post_margin).abs().mean()),
                     "games_list": k.assign(gap=(k.post_total - k.model_total).abs()).sort_values("gap", ascending=False)
                                   .head(8)[["label", "date", "model_total", "post_total", "total",
                                             "model_margin", "post_margin", "margin"]].to_dict("records")}
    inputs = []
    for key, (_, label) in INPUT_LABELS.items():
        cols = [c for c in (f"err_{key}_home", f"err_{key}_away") if c in d]
        if cols:
            e = pd.concat([d[c] for c in cols]).dropna()
            if len(e):
                inputs.append({"input": label, "n": int(len(e)), "bias": float(e.mean()), "mae": float(e.abs().mean())})
    out = {"games": int(len(d)), "resim": resim, "inputs": inputs,
           "margin": {"model_mae": float((d.model_margin - d.margin).abs().mean()),
                      "line_mae": float((d.line_margin - d.margin).abs().mean()) if d.line_margin.notna().any() else None},
           "total": {"model_mae": float((d.model_total - d.total).abs().mean()),
                     "line_mae": float((d.line_total - d.total).abs().mean()) if d.line_total.notna().any() else None},
           "by_week": [{"date": dt, "n": int(len(x)), "margin_mae": float((x.model_margin - x.margin).abs().mean()),
                        "total_mae": float((x.model_total - x.total).abs().mean())}
                       for dt, x in d.assign(wk=pd.to_datetime(d.date).dt.to_period("W").astype(str)).groupby("wk")],
           "biggest_misses": d.assign(miss=(d.model_total - d.total).abs()).sort_values("miss", ascending=False)
                              .head(5)[["label", "date", "model_total", "total", "model_margin", "margin"]].to_dict("records")}
    ups = [dict(label=r["label"], date=r["date"], **r["upset"]) for r in games if r.get("upset")]
    out["upsets"] = sorted(ups, key=lambda u: -u["line"])
    if prow:
        p = pd.DataFrame(prow)
        out["props"] = [{"market": m, "label": props.MARKETS[m], "n": int(len(x)), "model_mae": float((x["mean"] - x.y).abs().mean()),
                         "line_mae": float((x.line - x.y).abs().mean()), "hit": float(x.hit.dropna().mean()) if x.hit.notna().any() else None}
                        for m, x in p.groupby("market")]
    return out


def cross_checks(g: pd.DataFrame, lines: dict, rows: list[dict], upcoming: pd.Series) -> list[dict]:
    """Data checks run every build and shown on the research page: sources that disagree or are missing."""
    out = []
    cur = g[(g.season == sources.CURRENT_SEASON) & g.final & g.fbs_game]
    for col, name in (("home_ypp", "ESPN team box score"), ("home_epa", "play-by-play summary"), ("spread", "closing line")):
        if col in cur:
            miss = int(cur[col].isna().sum())
            out.append({"check": f"Finished FBS games this season with a {name}", "value": f"{len(cur) - miss} of {len(cur)}",
                        "ok": miss <= max(5, 0.05 * len(cur))})
    if "home_ypp" in cur and "home_epa" in cur:
        both = cur[cur.home_ypp.notna() & cur.home_epa.notna()]
        if len(both) > 20:
            c = float(np.corrcoef(both.home_ypp, both.home_epa)[0, 1])
            out.append({"check": "Box-score yards per play agrees with play-by-play EPA (correlation)", "value": f"{c:.2f}", "ok": c > 0.5})
    gap = []
    for gid, L in lines.items():
        books = [o["point"] for o in L.get("offers", []) if o["market"] == "spreads" and o["side"] == "home" and o["point"] is not None]
        espn = None
        if books and L.get("espn_spread") is not None:
            espn = L["espn_spread"]
            if abs(float(np.median(books)) - espn) >= 2.5:
                gap.append(gid)
    out.append({"check": "Games where ESPN's spread and the sportsbooks' differ by 2.5+ points", "value": str(len(gap)), "ok": len(gap) <= 3,
                "games": gap[:10]})
    # every matchup checked against ESPN's schedule, and no team listed twice
    seen: dict = {}
    for r in rows:
        for t in (r["home"], r["away"]):
            seen[t] = seen.get(t, 0) + 1
    twice = sorted(t for t, n in seen.items() if n > 1)
    out.append({"check": "Teams listed in more than one game this week", "value": ", ".join(twice) or "none", "ok": not twice})
    wrong = [r["game_id"] for r in rows if (L := lines.get(r["game_id"], {})).get("espn_home_id") is not None
             and (L["espn_home_id"], L["espn_away_id"]) != (r["home_id"], r["away_id"])]
    on_sb = sum(1 for r in rows if lines.get(r["game_id"], {}).get("espn_home_id") is not None)
    out.append({"check": "Matchups (home and away team) that match ESPN's schedule", "value": f"{on_sb - len(wrong)} of {on_sb}",
                "ok": not wrong, "games": wrong[:10]})
    no_line = sum(1 for r in rows if not r["line"]["has_line"])
    out.append({"check": "This week's games without a posted line yet", "value": f"{no_line} of {len(rows)}", "ok": True})
    return out


def qb_changes(pg: pd.DataFrame, season: int) -> dict:
    """Teams whose passer in their last game is not the one who has thrown the most this season: a likely
    quarterback change (injury or benching) that older ratings have not caught up with."""
    if pg.empty:
        return {}
    # any attempt counts: option offenses (Air Force, Army, Navy) often start a quarterback who throws 3 or 4 times
    p = pg[(pg.season == season) & (pg.pass_att >= 1) & (pg.athlete_name != "Team")]
    out = {}
    for tid, x in p.groupby("team_id"):
        lead = x.groupby("athlete_name").pass_att.sum().idxmax()
        last_gid = x.game_id.max()
        last = x[x.game_id == last_gid].sort_values(["pass_att", "rush_att"], ascending=False).athlete_name.iloc[0]
        if last != lead and x.game_id.nunique() >= 3:
            out[int(tid)] = {"season_leader": lead, "last_game": last}
    return out


# --------------------------------------------------------------------------- teams
def team_table(g: pd.DataFrame, season: int) -> list[dict]:
    """This season's record, against the spread and over/under, plus current ratings, for every FBS team."""
    now = pd.Timestamp(datetime.now(timezone.utc).replace(tzinfo=None))
    rt = {pre: history_rating(g, now, pre) for pre in ("r", "y", "n")}
    s = g[(g.season == season) & g.final]
    out = []
    fbs = set(s[s.home_division == "fbs"].home_id) | set(s[s.away_division == "fbs"].away_id)
    for tid in fbs:
        h = s[s.home_id == tid]
        a = s[s.away_id == tid]
        name = (h.home_team.iloc[0] if len(h) else a.away_team.iloc[0])
        conf = (h.home_conference.iloc[0] if len(h) else a.away_conference.iloc[0])
        mar = pd.concat([h.margin, -a.margin])
        ats = pd.concat([np.sign(h.margin + h.spread), np.sign(-a.margin - a.spread)]).dropna()
        ou = pd.concat([np.sign(h.pts - h.total), np.sign(a.pts - a.total)]).dropna()
        r = rt["r"]
        out.append({"team_id": int(tid), "team": name, "conference": conf if isinstance(conf, str) else None,
                    "w": int((mar > 0).sum()), "l": int((mar < 0).sum()),
                    "ats_w": int((ats > 0).sum()), "ats_l": int((ats < 0).sum()), "ats_p": int((ats == 0).sum()),
                    "over": int((ou > 0).sum()), "under": int((ou < 0).sum()),
                    "off": r["off"].get(tid), "def": r["def"].get(tid),
                    "ypp_off": rt["y"]["off"].get(tid), "ypp_def": rt["y"]["def"].get(tid), "pace": rt["n"]["off"].get(tid)})
    base = rt["r"]["base"]
    for t in out:
        t["net"] = (t["off"] + t["def"]) if t["off"] is not None and t["def"] is not None else None
        t["pts_for"] = base + t["off"] if t["off"] is not None else None
        t["pts_against"] = base - t["def"] if t["def"] is not None else None
        yb, nb = rt["y"]["base"], rt["n"]["base"]
        t["ypp_for"] = yb + t["ypp_off"] if t["ypp_off"] is not None else None
        t["ypp_against"] = yb - t["ypp_def"] if t["ypp_def"] is not None else None
        t["plays"] = nb + t["pace"] if t["pace"] is not None else None
    out.sort(key=lambda t: -(t["net"] or -99))
    for i, t in enumerate(out):
        t["power_rank"] = i + 1
    return out


def history_rating(g: pd.DataFrame, now: pd.Timestamp, pre: str) -> dict:
    from . import ratings  # noqa: PLC0415
    spec = next(s for s in model.RATINGS if s[0] == pre)
    return ratings.fit(g, now, spec[3], spec[4], spec[1], spec[2])


# --------------------------------------------------------------------------- props for featured games
def prop_rows(g: pd.DataFrame, oos: pd.DataFrame, up: pd.DataFrame, featured: set[int], lines: dict, log=print) -> tuple[list[dict], dict]:
    first = sources.CURRENT_SEASON - sources.PROP_SEASONS - 2
    pg = props.load_player_games(first)
    if pg.empty or not featured:
        return [], {"markets": {}, "note": "No featured games this week."}
    preds = pd.concat([oos[["game_id", "pred_home", "pred_away"]], up[["game_id", "pred_home", "pred_away"]]])
    gg = g[g.season >= first].drop(columns=[c for c in ("pred_home", "pred_away") if c in g]).merge(preds, on="game_id", how="left")
    d = props.attach_games(pg, gg)
    # tonight's rows: one per player who has played for a featured team this season and is a regular in a market
    fut = []
    for gid in featured:
        x = gg[gg.game_id == gid]
        if x.empty:
            continue
        x = x.iloc[0]
        for side, opp in (("home", "away"), ("away", "home")):
            roster = d[(d.team_id == x[f"{side}_id"]) & (d.season == x.season)].drop_duplicates("athlete_id")
            if roster.empty:
                continue
            fut.append(pd.DataFrame({"game_id": gid, "athlete_id": roster.athlete_id.to_numpy(),
                                     "athlete_name": roster.athlete_name.to_numpy(), "team_id": x[f"{side}_id"],
                                     "opp_id": x[f"{opp}_id"], "team": x[f"{side}_team"], "opp": x[f"{opp}_team"],
                                     "home": int(side == "home"), "date": x.date, "season": x.season,
                                     "exp_pts": x[f"pred_{side}"]}))
    if not fut:
        return [], {"markets": {}, "note": "No player history for this week's featured games."}
    fut = pd.concat(fut, ignore_index=True)
    for c in ("pass_yds", "pass_td", "pass_att", "rush_yds", "rush_att", "rec_yds", "receptions"):
        fut[c] = np.nan
    allp = pd.concat([d, fut], ignore_index=True).sort_values(["date", "game_id"]).reset_index(drop=True)
    f = props.features(allp)
    hist = f[f.pass_yds.notna()]
    wf = props.walk_forward(hist, sources.CURRENT_SEASON - sources.PROP_SEASONS + 1, log=log)
    tiers, legs = {}, []
    for m in props.MARKETS:
        r = wf[(wf.market == m) & (wf.y != wf.line)]
        dd = pd.DataFrame({"p": np.maximum(r.p_over, 1 - r.p_over), "won": np.where(r.p_over >= 0.5, r.y > r.line, r.y < r.line).astype(int),
                           "season": r.season})
        seasons = sorted(dd.season.unique())
        tiers[m] = {"label": props.MARKETS[m], "tiers": report.tier_rows(dd, tiers=PROP_TIERS, recent=seasons[-2:]),
                    "n": int(len(dd)), "line": "usual"}
        legs.append(dd.assign(market=m, dec=rating.DEC110, q=0.5))
    PL = pd.concat(legs, ignore_index=True) if legs else pd.DataFrame()
    rater = None
    if len(PL) and PL.season.nunique() >= 2:
        PL["ret"] = PL.won * PL.dec - 1
        rater = rating.fit(PL)
        seasons = sorted(PL.season.unique())
        rating_report = rating.bands(rating.walk_forward(PL, min_seasons=1), [int(x) for x in seasons[-2:]])
    else:
        rating_report = None
    now_rows = f[f.pass_yds.isna()]
    out = []
    for m in props.MARKETS:
        r, ratios = props.fit(hist, m)
        t = now_rows[props.eligible(now_rows, m)]
        if t.empty:
            continue
        mu = np.expm1(r.predict(props.design(t, m))).clip(min=0.5)
        usual = props.usual_line(allp, m).loc[t.index]
        for (_, x), mu_i, ul in zip(t.iterrows(), mu, usual):
            offers = [o for o in lines.get(int(x.game_id), {}).get("props", []) if o["market"] == m and _norm(o["player"]) == _norm(x.athlete_name)]
            book_lines = [o["line"] for o in offers if o.get("line") is not None]
            line = float(pd.Series(book_lines).mode().iloc[0]) if book_lines else (ul if ul == ul else math.floor(mu_i) + 0.5)
            po = float(props.p_over(np.array([mu_i]), ratios, np.array([line]))[0])
            side = "over" if po >= 0.5 else "under"
            p = max(po, 1 - po)
            tr = tier_of(tiers[m]["tiers"], p)
            recent = hist[hist.athlete_id == x.athlete_id].sort_values("date").tail(8)[m].tolist()[::-1]
            row = {"game_id": int(x.game_id), "player": x.athlete_name, "player_id": str(int(x.athlete_id)), "team": x.team,
                   "opp": x.opp, "market": m, "label": props.MARKETS[m], "mean": float(mu_i), "line": line,
                   "line_source": "book" if book_lines else "usual", "p_over": po, "side": side, "p": p,
                   "tier": tr["tier"] if tr else None,
                   # picks only at lines books post
                   "proven": bool(tr and tr["proven"] and book_lines), "recent": recent,
                   "best": _best([{**o, "market": "p"} for o in offers], market="p", side=side, line=line)}
            out.append(score_lean(row, rater, m))
    out.sort(key=lambda r: -r["score"])
    return out, {"markets": tiers, "rating": rating_report, "note": "Backtest at each player's usual line (median of his last five games); books' "
                                           "prop lines are sharper, so the live record on posted lines is what counts."}


def player_pages(g: pd.DataFrame, pg: pd.DataFrame, props_rows: list[dict]) -> dict:
    """This season's game log for every player with a prop this week (newest first), for the tap-a-player page."""
    ids = {int(r["player_id"]) for r in props_rows}
    if pg.empty or not ids:
        return {}
    d = props.attach_games(pg[pg.athlete_id.isin(ids)], g[g.season == sources.CURRENT_SEASON])
    pages = {}
    for aid, x in d.groupby("athlete_id"):
        pid = str(int(aid))
        x = x.sort_values("date", ascending=False)
        pages[pid] = {"player_id": pid, "player_name": x.athlete_name.iloc[0], "team": x.team.iloc[0],
                      "log": [{"date": str(pd.Timestamp(y.date).date()), "opp": y.opp, "home": int(y.home),
                               **{c: float(getattr(y, c)) for c in ("pass_yds", "pass_att", "pass_td", "rush_yds", "rush_att", "rec_yds", "receptions")}}
                              for y in x.itertuples()],
                      "props": [r for r in props_rows if r["player_id"] == pid]}
    return pages


PROP_TIERS = [("Coin flip", 0.50, 0.55), ("Lean", 0.55, 0.60), ("Solid", 0.60, 0.65), ("Strong", 0.65, 1.0)]


# --------------------------------------------------------------------------- pipeline
def run(out: Path, log=print, today: str | None = None, now: datetime | None = None) -> dict:
    today = today or collect.today_et()
    now = now or datetime.now(timezone.utc)
    t0 = datetime.now(timezone.utc)
    g = history.load_games()
    g = g.merge(history.load_team_box(), on="game_id", how="left")
    g = g.merge(history.load_pbp_stats(), on="game_id", how="left")
    lines = live_lines(today)
    # this week's games take the live line (closing lines arrive upstream after the games)
    nowts = pd.Timestamp(now.replace(tzinfo=None))
    upcoming = this_week(g, nowts)
    for c, k in (("spread", "spread"), ("total", "total"), ("ml_home", "ml_home"), ("ml_away", "ml_away")):
        vals = g.loc[upcoming, "game_id"].map(lambda gid: lines.get(gid, {}).get(k))
        g.loc[upcoming, c] = pd.to_numeric(vals, errors="coerce")
    g = g.join(model.rate(g, sources.FIRST_SEASON + 2))
    log(f"cfb: {int(g.final.sum()):,} finished games, {int(upcoming.sum())} this week")
    oos = model.walk_forward(g, sources.FIRST_TEST_SEASON, log=log)
    bt = report.simulate_backtest(oos)
    summary = report.summarize(bt)
    opening = report.opening_totals(oos, bt)
    upset = report.upsets(bt)
    legs = rating.legs_from_backtest(bt)
    rater = rating.fit(legs)
    rating_report = rating.bands(rating.walk_forward(legs), summary["recent_seasons"])
    alt_report = report.alt_lines(oos)
    log(f"cfb rating: " + ", ".join(f"{b['lo']}+ {b['roi']:+.1%} (n={b['n']})" for b in rating_report["bands"] if b["n"]))
    finds = report.findings(g)
    for m, v in summary["markets"].items():
        log(f"cfb backtest {m}: proven tiers {[t['tier'] for t in v['tiers'] if t['proven']]}")

    up = g[upcoming].copy()
    rows, props_rows, prop_tiers, coefs, sims = [], [], {"markets": {}}, {}, {}
    if len(up):
        up, coefs = model.fit_live(g, up)
        for side in ("home", "away"):
            posted = up.game_id.map(lambda gid: _posted_tt(lines.get(gid, {}), side))
            up[f"tt_{side}_posted"] = posted.notna()
            up[f"tt_{side}"] = posted.where(posted.notna(), model.implied_team_total(up.spread, up.total, side))
        rank = up.game_id.map(lambda gid: _rank_score(lines.get(gid, {})))
        if rank.notna().any() or any(L.get("home_rank") or L.get("away_rank") for L in lines.values()):
            up["featured"] = rank.notna()
        else:   # no AP ranks saved (ESPN unreachable): both teams in our top 25
            top = {t["team_id"] for t in team_table(g, sources.CURRENT_SEASON)[:25]}
            up["featured"] = up.home_id.isin(top) & up.away_id.isin(top)
        up["featured"] |= up.game_id.map(lambda gid: bool(lines.get(gid, {}).get("props")))
        up = up.sort_values(["date", "game_id"]).reset_index(drop=True)
        pool = model.miss_pool(oos, nowts)
        h, a = model.simulate(up.pred_home.to_numpy(), up.pred_away.to_numpy(), pool, seed=7)
        sims = sim_strings(up, h, a)
        # games without a posted line are still simulated (for the projection), at a placeholder line nobody sees
        sp = up.spread.fillna(0.5).to_numpy()
        tot = up.total.fillna(50.5).to_numpy()
        ch = model.chances(h, a, sp, tot, up.tt_home.fillna(0).to_numpy(), up.tt_away.fillna(0).to_numpy())
        qb = qb_changes(props.load_player_games(sources.CURRENT_SEASON), sources.CURRENT_SEASON)
        rows = game_rows(up, ch, summary, lines, qb, rater)
        idx = {gid: i for i, gid in enumerate(up.game_id)}
        for r in rows:
            i = idx.get(r["game_id"])
            offers = lines.get(r["game_id"], {}).get("alts", [])
            r["alts"] = alt_rows(offers, h[i] - a[i], h[i] + a[i], alt_report["markets"]) if offers and i is not None else []
        for r in rows:
            for m in r["markets"]:
                m["reasons"] = reasons(r, m)
        featured = {r["game_id"] for r in rows if r["featured"]}
        try:
            props_rows, prop_tiers = prop_rows(g, oos, up, featured, lines, log=log)
        except Exception as ex:  # noqa: BLE001 - props are a side dish; the game lines still publish
            log(f"cfb props: skipped ({ex})")
    frozen = freeze(rows, now, props_rows)
    rec = record(g, summary)
    pg_now = props.load_player_games(sources.CURRENT_SEASON)
    card = report_card(g, pg_now, model.fit_box(g, nowts), model.miss_pool(oos, nowts))
    checks = cross_checks(g, lines, rows, upcoming)
    teams = team_table(g, sources.CURRENT_SEASON)

    picks = [{"game_id": r["game_id"], "date": r["date"], "home": r["home"], "away": r["away"], **m}
             for r in rows for m in r["markets"] if m["proven"]]
    picks.sort(key=lambda p: -p["score"])
    out.mkdir(parents=True, exist_ok=True)
    _write(out, "week.json", {"generated_at": utcnow(), "games": rows, "picks": picks,
                              "odds": {"books_games": sum(1 for r in rows if (r["line"]["source"] or "").endswith("sportsbooks")),
                                       "espn_games": sum(1 for r in rows if (r["line"]["source"] or "").startswith("ESPN")),
                                       "no_line": sum(1 for r in rows if not r["line"]["has_line"])}})
    _write(out, "sims.json", {"generated_at": utcnow(), "n": PARLAY_SIMS, "games": sims})
    _write(out, "props.json", {"generated_at": utcnow(), "rows": props_rows, "backtest": prop_tiers})
    _write(out, "backtest.json", {**summary, "opening_totals": opening, "upsets": upset, "rating": rating_report, "alt_lines": alt_report,
                                  "coefficients": coefs,
                                  "model": {"ratings_half_life_days": model.RATINGS[0][3],
                                            "recency_half_life_seasons": model.RECENCY_HALF_LIFE, "sims": model.SIMS}})
    _write(out, "findings.json", {"rules": finds, "break_even": report.BREAK_EVEN})
    _write(out, "record.json", {**rec, "report_card": card})
    _write(out, "teams.json", {"season": sources.CURRENT_SEASON, "teams": teams})
    try:
        for pid, page in player_pages(g, pg_now, props_rows).items():
            _write(out, f"players/{pid}.json", page)
    except Exception as ex:  # noqa: BLE001 - same as props: never block the game lines
        log(f"cfb player pages: skipped ({ex})")
    prev_rater = rating.fit(legs[legs.season < sources.CURRENT_SEASON]) if (legs.season < sources.CURRENT_SEASON).any() else rater
    _write(out, "previous.json", previous_weeks(g, bt, summary, prev_rater, sources.CURRENT_SEASON))
    fin = g[g.final]
    status = {"generated_at": utcnow(), "seconds": (datetime.now(timezone.utc) - t0).total_seconds(),
              "season": sources.CURRENT_SEASON, "games_this_week": len(rows), "picks": len(picks),
              "props": len(props_rows), "frozen": frozen,
              "history": {"first_season": int(fin.season.min()), "games": int(len(fin)),
                          "lined_games": int((fin.spread.notna()).sum()), "last_game_date": str(fin.date.max().date())},
              "proven": {m: [t["tier"] for t in v["tiers"] if t["proven"]] for m, v in summary["markets"].items()},
              "checks": checks,
              "license": sources.LICENSE_NOTE}
    _write(out, "status.json", status)
    log(f"cfb: wrote site data ({len(rows)} games, {len(picks)} picks, {len(props_rows)} prop rows) in {status['seconds']:.0f}s")
    return status


def _posted_tt(L: dict, side: str) -> float | None:
    ls = [o["line"] for o in L.get("team_totals", []) if o["team"] == side and o.get("line") is not None]
    return float(pd.Series(ls).mode().iloc[0]) if ls else None


def _rank_score(L: dict) -> float | None:
    h, a = L.get("home_rank"), L.get("away_rank")
    if h and a:
        return h + a
    if min(h or 99, a or 99) <= 10:
        return 50 + min(h or 99, a or 99)
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="cfb.pipeline")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "site-data" / "cfb"))
    ap.add_argument("--today")
    a = ap.parse_args(argv)
    run(Path(a.out), today=a.today)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
