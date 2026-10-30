"""Post-game re-simulation of every NFL game, from the simulation frozen at kickoff.

  python -m engine.simreview        # rerun every finished frozen game, writes data/results/sim_report.json

Before kickoff (every site update, from gamesim.attach) each upcoming game's simulation inputs are saved exactly as the
site used them: every player's share of targets and carries, catch rate, yards per target and per carry, the team's
expected passes and runs, the betting line, the league corrections in use, and the simulated range of every stat.
Rows for a game freeze at kickoff, like the pick log, so nothing is reviewed with hindsight.

Once the game is final and the box score is in, the frozen game is simulated again (N_SIMS runs, same random draws) with
what really happened swapped in one layer at a time:

  1. who played      players expected to play who sat out are removed (their share goes to the rest)
  2. team volume     the team's real pass attempts, targets and carries, and the real score (TD chances)
  3. roles           each player's real share of the targets and carries, and the passer who really threw
  4. efficiency      each player's real catch rate, yards per target, yards per carry, TD and interception rate

How much each layer cuts the typical miss, market by market, is where the pregame inputs were off; what is left after
layer 4 is plain chance. Each input is also compared directly (actual minus pregame), per game and over the season, so a
bias that keeps pointing the same way shows up. The league-wide versions of those inputs feed the next simulation:
team volume (gamesim.volume_factor) and efficiency where their walk-forward test helped (gamesim.correction_test),
both refit every update from the newest finished weeks.

Frozen files live in FG_SIMS_DIR (default: next to the pick log); the hosted site keeps them on the nfl-data branch.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import db, gamesim, paths, picklog, props
from .util import utcnow

INPUT_COLS = ["player_id", "player_name", "position", "team", "spread_for", "team_implied_total", "team_attempts_pg",
              "team_carries_pg", "team_targets_pg", "targets_share", "carries_share", "last_carries_share", "catch_rate", "ypt", "ypc", "attempts_pg",
              "pass_tds_pg", "interceptions_pg", "opp_attempts_mult", "opp_carries_mult", "opp_targets_mult",
              "opp_receptions_mult", "opp_rec_yards_mult", "opp_rush_yards_mult", "opp_interceptions_mult", "opp_pass_tds_mult",
              "has_history", "snap_pct", "status", "report_status"]
STATS = ["targets", "receptions", "rec_yards", "carries", "rush_yards", "attempts", "completions", "pass_yards", "pass_tds",
         "interceptions", "rush_rec_yards"]
# market -> stat in the simulation (and in the box score)
MARKETS = {m: props.MARKETS[m]["stat"] for m in gamesim.SIM_MARKETS}
QB_MARKETS = {"pass_yards", "pass_attempts", "completions", "pass_tds", "interceptions"}
LEVELS = [("pregame", "Pregame"), ("played", "+ who played"), ("volume", "+ team volume"), ("roles", "+ roles"),
          ("efficiency", "+ efficiency")]
CAUSES = {"played": "who played", "volume": "team volume", "roles": "his role", "efficiency": "efficiency"}
# Inputs compared directly, the unit they are shown in, and the league correction that learns from them.
INPUTS = {
    "team_attempts": {"label": "Team pass attempts", "unit": "passes", "feeds": "pass_adj"},
    "team_carries": {"label": "Team rush attempts", "unit": "carries", "feeds": "rush_adj"},
    "points": {"label": "Points vs implied total", "unit": "points", "feeds": None},
    "margin": {"label": "Favorite's margin vs spread", "unit": "points", "feeds": None},
    "sat_out": {"label": "Expected players who sat out", "unit": "players", "feeds": None},
    "target_share": {"label": "Target share", "unit": "pct pts", "feeds": None},
    "carry_share": {"label": "Carry share", "unit": "pct pts", "feeds": None},
    "catch_rate": {"label": "Catch rate", "unit": "pct pts", "feeds": "catch_adj"},
    "ypt": {"label": "Yards per target", "unit": "yards", "feeds": "ypt_adj"},
    "ypc": {"label": "Yards per carry", "unit": "yards", "feeds": "ypc_adj"},
    "ypa": {"label": "Yards per pass attempt", "unit": "yards", "feeds": "ypt_adj"},
    "snap_share": {"label": "Snap share", "unit": "pct pts", "feeds": None},
}
MIN_TARGETS, MIN_CARRIES, MIN_ATTEMPTS = 3, 5, 10   # rates need some volume before they mean anything
CLEAR_MIN_N = 30


def sims_dir() -> Path:
    return Path(os.environ.get("FG_SIMS_DIR") or picklog.picks_dir().parent / "sims")


def week_path(season: int, week: int) -> Path:
    return sims_dir() / f"{season}-w{week:02d}.json"


def _clean(v):
    if isinstance(v, (np.floating, float)):
        return None if not np.isfinite(v) else round(float(v), 4)
    if isinstance(v, np.integer):
        return int(v)
    return None if v is pd.NA or (isinstance(v, float) and v != v) else v


def _summary(d: dict[str, np.ndarray]) -> dict:
    return {st: {"mean": round(float(np.mean(x)), 2), "med": round(float(np.median(x)), 2), "q10": round(float(np.percentile(x, 10)), 2),
                 "q90": round(float(np.percentile(x, 90)), 2)} for st, x in d.items() if st in STATS}


def _seed(game_id: str, team: str) -> int:
    return sum((i + 1) * ord(ch) for i, ch in enumerate(f"{game_id}|{team}")) % (2 ** 31)


def simulate(rows: list[dict], params: dict, game_id: str, team: str, n: int) -> dict:
    """One team's frozen (or post-game) inputs simulated n times with that game's fixed seed."""
    if not rows:
        return {}
    return gamesim.simulate_team(pd.DataFrame(rows), np.random.default_rng(_seed(game_id, team)), n, params, with_team=True)


# --------------------------------------------------------------------------- before kickoff
def freeze(c, rows: pd.DataFrame, season: int, week: int, params: dict, n: int = gamesim.N_SIMS, now: datetime | None = None,
           log=print) -> dict:
    """Save each upcoming game's simulation inputs and results. Games that already kicked off keep what was saved."""
    now = now or datetime.now(timezone.utc)
    ko = picklog._kickoffs(c, season, week)
    started = {g for g, t in ko.items() if t is not None and t <= now}
    f = week_path(season, week)
    old = json.loads(f.read_text()) if f.exists() else {"season": season, "week": week, "games": {}}
    games = {g: v for g, v in old["games"].items() if g in started}
    rows = rows[rows.has_history.eq(1) & rows.game_id.notna()] if len(rows) else rows
    cols = [c_ for c_ in INPUT_COLS if c_ in rows.columns]
    for gid, g in rows.groupby("game_id"):
        if gid in started:
            continue
        teams = {}
        for team, t in g.groupby("team"):
            recs = [{k: _clean(v) for k, v in r.items()} for r in t[cols].to_dict("records")]
            sims = simulate(recs, params, gid, team, n)
            teams[team] = {"inputs": recs, "team": _summary(sims.pop(gamesim.TEAM, {})),
                           "players": {pid: _summary(d) for pid, d in sims.items()}}
        games[gid] = {"game_id": gid, "kickoff": ko[gid].isoformat() if ko.get(gid) else None, "frozen_at": now.isoformat(),
                      "params": {k: float(v) for k, v in params.items()}, "sims": n, "teams": teams}
    out = {"season": season, "week": week, "updated_at": now.isoformat(), "games": games}
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(out, separators=(",", ":")))
    log(f"simreview: {season} week {week}: pregame sims saved for {len(games) - len(set(games) & started)} upcoming games, "
        f"{len(set(games) & started)} frozen at kickoff")
    return out


# --------------------------------------------------------------------------- after the game
def _box(c, season: int, week: int) -> tuple[pd.DataFrame, dict]:
    """Players who took part (with their real stats and snap share) and each team's real volume and score."""
    h = props.load_history(c)
    h = h[(h.season == season) & (h.week == week)]
    teams = h.groupby(["game_id", "team"])[["attempts", "carries", "targets"]].sum()
    score = {}
    for r in c.execute("SELECT game_id, home_team, away_team, home_score, away_score FROM games WHERE season=? AND week=? "
                       "AND home_score IS NOT NULL", (season, week)):
        score[(r["game_id"], r["home_team"])] = (r["home_score"], r["away_score"])
        score[(r["game_id"], r["away_team"])] = (r["away_score"], r["home_score"])
    vol = {k: {"attempts": float(v.attempts), "carries": float(v.carries), "targets": float(v.targets),
               "points": float(score[k][0]), "allowed": float(score[k][1])} for k, v in teams.iterrows() if k in score}
    return h.set_index(["game_id", "player_id"]), vol


def _layers(inputs: list[dict], box: pd.DataFrame, gid: str, vol: dict) -> dict[str, list[dict]]:
    """The frozen inputs with what really happened swapped in, one layer on top of the last."""
    def actual(pid):
        return box.loc[(gid, pid)] if (gid, pid) in box.index else None

    out = {"pregame": inputs}
    played = [r for r in inputs if actual(r["player_id"]) is not None]
    out["played"] = played
    vol_ = [dict(r, att_exact=vol["attempts"], car_exact=vol["carries"], tgt_exact=vol["targets"],
                 team_implied_total=vol["points"], spread_for=vol["points"] - vol["allowed"]) for r in played]
    out["volume"] = vol_
    roles = []
    for r in vol_:
        a = actual(r["player_id"])
        roles.append(dict(r, targets_share=float(a.targets) / max(vol["targets"], 1.0), carries_share=float(a.carries) / max(vol["carries"], 1.0),
                          last_carries_share=None, attempts_pg=float(a.attempts), opp_targets_mult=1.0, opp_carries_mult=1.0))
    out["roles"] = roles
    eff = []
    for r in roles:
        a = actual(r["player_id"])
        e = dict(r, opp_receptions_mult=1.0, opp_rec_yards_mult=1.0, opp_rush_yards_mult=1.0)
        if a.targets > 0:
            e["catch_rate"] = float(a.receptions) / float(a.targets)
            e["ypt"] = float(a.rec_yards) / float(a.targets)
        if a.carries > 0:
            e["ypc"] = float(a.rush_yards) / float(a.carries)
        if a.attempts > 0:
            e["td_rate_exact"] = float(a.pass_tds) / float(a.attempts)
            e["int_rate_exact"] = float(a.interceptions) / float(a.attempts)
        eff.append(e)
    out["efficiency"] = eff
    return out


# Each layer after "pregame" with its own settings: once the real numbers are in, nothing is left to guess.
LAYER_PARAMS = {"played": {}, "volume": {"pass_adj": 1.0, "rush_adj": 1.0, "vol_sd": 0.0},
                "roles": {"pass_adj": 1.0, "rush_adj": 1.0, "vol_sd": 0.0, "alpha_tgt": 1e4, "alpha_car": 1e4, "fill_tgt": 0.0,
                          "fill_car": 0.0, "other_min_tgt": 0.0, "other_min_car": 0.0}}
LAYER_PARAMS["efficiency"] = {**LAYER_PARAMS["roles"], "catch_adj": 1.0, "ypt_adj": 1.0, "ypc_adj": 1.0}


def _rate(num, den):
    return num / den if den else None


def review_game(game: dict, box: pd.DataFrame, vol: dict, n: int | None = None) -> dict | None:
    """Rerun one frozen game layer by layer. None while its box score is not in."""
    gid = game["game_id"]
    n = n or game.get("sims") or gamesim.N_SIMS
    if not all((gid, t) in vol for t in game["teams"]):
        return None
    rows, inputs, teams = [], [], []
    for team, t in game["teams"].items():
        v = vol[(gid, team)]
        lay = _layers(t["inputs"], box, gid, v)
        runs = {lv: simulate(lay[lv], {**game["params"], **LAYER_PARAMS.get(lv, {})}, gid, team, n) for lv, _ in LEVELS}
        pre = runs["pregame"]
        pt = pre.get(gamesim.TEAM, {})
        r0 = t["inputs"][0]
        exp_att, exp_car, exp_tgt = (float(np.mean(pt[k])) for k in ("attempts", "carries", "targets"))
        sat = [r for r in t["inputs"] if (gid, r["player_id"]) not in box.index]
        teams.append({"team": team, "attempts": v["attempts"], "exp_attempts": round(exp_att, 1), "carries": v["carries"],
                      "exp_carries": round(exp_car, 1), "points": v["points"], "implied": r0.get("team_implied_total"),
                      "sat_out": [r["player_name"] for r in sat if _played_role(pre.get(r["player_id"], {}))]})
        inputs += [{"input": "team_attempts", "team": team, "pre": exp_att, "actual": v["attempts"]},
                   {"input": "team_carries", "team": team, "pre": exp_car, "actual": v["carries"]},
                   {"input": "sat_out", "team": team, "pre": 0.0, "actual": float(len(teams[-1]["sat_out"]))}]
        if r0.get("team_implied_total") is not None:
            inputs.append({"input": "points", "team": team, "pre": r0["team_implied_total"], "actual": v["points"]})
        if r0.get("spread_for") is not None and r0["spread_for"] >= 0 and not any(x["input"] == "margin" for x in inputs):
            # once per game, from the favorite's side: positive = the favorite won by more than the spread
            inputs.append({"input": "margin", "team": team, "pre": r0["spread_for"], "actual": v["points"] - v["allowed"]})
        for r in t["inputs"]:
            pid = r["player_id"]
            d = pre.get(pid, {})
            if (gid, pid) not in box.index or not d:
                continue
            a = box.loc[(gid, pid)]
            who = {"team": team, "player": r["player_name"], "position": r["position"]}
            mt = float(np.mean(d.get("targets", [0.0])))
            mc = float(np.mean(d.get("carries", [0.0])))
            if r["position"] != "QB" and mt >= 1:
                inputs.append({"input": "target_share", **who, "pre": 100 * mt / max(exp_tgt, 1.0), "actual": 100 * a.targets / max(v["targets"], 1.0)})
                if a.targets >= MIN_TARGETS:
                    inputs += [{"input": "catch_rate", **who, "pre": 100 * float(np.mean(d["receptions"])) / mt, "actual": 100 * a.receptions / a.targets},
                               {"input": "ypt", **who, "pre": float(np.mean(d["rec_yards"])) / mt, "actual": a.rec_yards / a.targets}]
            if mc >= 1:
                inputs.append({"input": "carry_share", **who, "pre": 100 * mc / max(exp_car, 1.0), "actual": 100 * a.carries / max(v["carries"], 1.0)})
                if a.carries >= MIN_CARRIES:
                    inputs.append({"input": "ypc", **who, "pre": float(np.mean(d["rush_yards"])) / mc, "actual": a.rush_yards / a.carries})
            if r["position"] == "QB" and "attempts" in d and a.attempts >= MIN_ATTEMPTS:
                inputs.append({"input": "ypa", **who, "pre": float(np.mean(d["pass_yards"])) / max(float(np.mean(d["attempts"])), 1.0),
                               "actual": a.pass_yards / a.attempts})
            if r.get("snap_pct") is not None and a.offense_pct == a.offense_pct and a.offense_pct is not None:
                inputs.append({"input": "snap_share", **who, "pre": 100 * float(r["snap_pct"]), "actual": 100 * float(a.offense_pct)})
            for m, st in MARKETS.items():
                if st not in d or (m in QB_MARKETS) != (r["position"] == "QB"):
                    continue
                if m not in QB_MARKETS and float(np.median(d[st])) < 1:
                    continue  # players with no real role add noise, not insight
                act = float(a[st]) if st in a.index else None
                if act is None:
                    continue
                miss = {lv: abs(float(np.median(runs[lv][pid][st])) - act) for lv, _ in LEVELS if st in runs[lv].get(pid, {})}
                if len(miss) < len(LEVELS):
                    continue
                rows.append({"market": m, **who, "pre": round(float(np.median(d[st])), 1), "mean": round(float(np.mean(d[st])), 2), "actual": act,
                             "q10": float(np.percentile(d[st], 10)), "q90": float(np.percentile(d[st], 90)), "miss": miss})
    for x in inputs:
        x["pre"], x["actual"] = round(float(x["pre"]), 3), round(float(x["actual"]), 3)
    return {"game_id": gid, "kickoff": game.get("kickoff"), "frozen_at": game.get("frozen_at"), "params": game["params"], "sims": n,
            "teams": teams, "rows": rows, "inputs": inputs}


def _played_role(d: dict) -> bool:
    """A player the pregame sim gave a real role (a target, a carry or the passing)."""
    return any(st in d and float(np.mean(d[st])) >= 1 for st in ("targets", "carries", "attempts"))


def _cause(miss: dict) -> str:
    drops = {lv: miss[prev] - miss[lv] for (prev, _), (lv, _) in zip(LEVELS, LEVELS[1:])}
    lv, best = max(drops.items(), key=lambda kv: kv[1])
    return CAUSES[lv] if best > 0.25 * max(miss["pregame"], 1e-9) else "chance"


def _market_table(rows: list[dict]) -> list[dict]:
    out = []
    for m in [m for m in MARKETS if any(r["market"] == m for r in rows)]:
        sel = [r for r in rows if r["market"] == m]
        miss = {lv: float(np.mean([r["miss"][lv] for r in sel])) for lv, _ in LEVELS}
        base = max(miss["pregame"], 1e-9)
        share = {lv: max(miss[prev] - miss[lv], 0.0) / base for (prev, _), (lv, _) in zip(LEVELS, LEVELS[1:])}
        out.append({"market": m, "label": props.MARKETS[m]["label"], "n": len(sel),
                    # against the simulated average: yards are skewed, so the median sits below it by design
                    "bias": round(float(np.mean([r["actual"] - r.get("mean", r["pre"]) for r in sel])), 2),
                    "in_range": round(float(np.mean([r["q10"] <= r["actual"] <= r["q90"] for r in sel])), 3),
                    "miss": {lv: round(v, 2) for lv, v in miss.items()},
                    "share": {lv: round(v, 3) for lv, v in share.items()}, "chance": round(miss["efficiency"] / base, 3)})
    return out


def _input_table(inputs: list[dict], last: list[dict], params: dict, corrections: dict) -> list[dict]:
    out = []
    for key, meta in INPUTS.items():
        sel = [x["actual"] - x["pre"] for x in inputs if x["input"] == key]
        if not sel:
            continue
        e = np.array(sel)
        se = float(e.std(ddof=1) / np.sqrt(len(e))) if len(e) > 1 else None
        clear = bool(len(e) >= CLEAR_MIN_N and se and abs(e.mean()) > 1.645 * se)
        lw = [x["actual"] - x["pre"] for x in last if x["input"] == key]
        feeds = meta["feeds"]
        used = None
        if feeds in ("pass_adj", "rush_adj"):
            cr = corrections.get("volume") or {}
            used = {"key": feeds, "value": params.get(feeds, 1.0), "adopted": bool(cr.get("adopt")), "gain": cr.get("gain")}
        elif feeds:
            cr = corrections.get(feeds) or {}
            used = {"key": feeds, "value": params.get(feeds), "adopted": bool(cr.get("adopt")), "gain": cr.get("gain")}
        out.append({"input": key, "label": meta["label"], "unit": meta["unit"], "n": len(e), "bias": round(float(e.mean()), 2),
                    "typical_miss": round(float(np.median(np.abs(e))), 2), "last_week_bias": round(float(np.mean(lw)), 2) if lw else None,
                    "last_week_n": len(lw), "clear": clear, "correction": used})
    return out


def _game_notes(g: dict) -> list[str]:
    """The few inputs that were furthest off in one game, in plain words."""
    notes = []
    for t in g["teams"]:
        for k, unit, sd in (("attempts", "passes", 7.0), ("carries", "runs", 6.0)):
            gap = t[k] - t[f"exp_{k}"]
            if abs(gap) >= sd:
                notes.append((abs(gap) / sd, f"{t['team']} {'ran' if k == 'carries' else 'threw'} {t[k]:.0f} {unit}, the sim expected {t[f'exp_{k}']:.0f}"))
        if t["sat_out"]:
            notes.append((3.0, f"{t['team']}: {', '.join(t['sat_out'])} expected to play but sat out"))
    for x in g["inputs"]:
        if x["input"] in ("target_share", "carry_share"):
            gap = x["actual"] - x["pre"]
            if abs(gap) >= 12:
                what = "targets" if x["input"] == "target_share" else "carries"
                notes.append((abs(gap) / 12, f"{x['player']} got {x['actual']:.0f}% of the {what}, the sim gave him {x['pre']:.0f}%"))
    return [s for _, s in sorted(notes, key=lambda z: -z[0])[:3]]


def _matchup(gid: str) -> str:
    parts = gid.split("_")
    return f"{parts[2]} at {parts[3]}" if len(parts) == 4 else gid


CACHE_VERSION = 2


def _cache_key(game: dict, box: pd.DataFrame, vol: dict, n) -> str:
    """Changes when the frozen game or its box score changes (stat corrections), so only those games are rerun."""
    gid = game["game_id"]
    b = box.loc[gid] if gid in box.index.get_level_values(0) else pd.DataFrame()
    stats = [round(float(b[s].sum()), 1) for s in ("targets", "receptions", "rec_yards", "carries", "rush_yards", "attempts", "pass_yards")] if len(b) else []
    return json.dumps([CACHE_VERSION, game.get("frozen_at"), n, stats, sorted((t, v) for (g, t), v in vol.items() if g == gid)], default=str)


def report(c, n: int | None = None, log=print) -> dict:
    files = sorted(sims_dir().glob("*.json")) if sims_dir().exists() else []
    games, pending = [], 0
    cf = paths.results_dir() / "sim_review_cache.json"
    try:
        cache = json.loads(cf.read_text()) if cf.exists() else {}
    except ValueError:
        cache = {}
    fresh = {}
    for f in files:
        w = json.loads(f.read_text())
        box, vol = _box(c, w["season"], w["week"])
        for gid, game in w["games"].items():
            k = _cache_key(game, box, vol, n)
            r = cache[gid]["review"] if gid in cache and cache[gid]["key"] == k else review_game(game, box, vol, n)
            if r is None:
                pending += 1
                continue
            fresh[gid] = {"key": k, "review": r}
            games.append(dict(r, season=w["season"], week=w["week"]))
    paths.results_dir().mkdir(parents=True, exist_ok=True)
    cf.write_text(json.dumps(fresh, default=float))
    from . import gamesim as gs  # noqa: PLC0415
    rep_g = gs.latest() or {}
    corrections = rep_g.get("corrections") or {}
    if not games:
        return {"available": False, "created_at": utcnow(), "pending": pending,
                "empty_reason": "Every game's simulation is now frozen at kickoff. The first post-game re-simulations appear once "
                                "those games are final and their box scores are in (usually the next morning)."}
    last = max((g["season"], g["week"]) for g in games)
    lastg = [g for g in games if (g["season"], g["week"]) == last]
    rows = [r for g in games for r in g["rows"]]
    inputs = [x for g in games for x in g["inputs"]]
    params = max(lastg, key=lambda g: g.get("frozen_at") or "")["params"]
    misses, seen = [], set()
    for r in sorted([dict(r, game_id=g["game_id"], cause=_cause(r["miss"])) for g in lastg for r in g["rows"] if r["market"] != "rush_rec_yards"],
                    key=lambda r: -r["miss"]["pregame"]):
        if r["player"] not in seen and len(misses) < 10:   # one line per player
            seen.add(r["player"])
            misses.append(r)
    mk = _market_table(rows)
    it = _input_table(inputs, [x for g in lastg for x in g["inputs"]], params, corrections)
    notes = []
    usage = ("played", "volume", "roles")
    big = max([m for m in mk if m["market"].endswith("yards")], key=lambda m: sum(m["share"][lv] for lv in usage), default=None)
    if big and sum(big["share"][lv] for lv in usage) > 0:
        top = max(usage, key=lambda lv: big["share"][lv])
        notes.append(f"{big['label']}: knowing who played, the team's volume and each player's role would have cut the typical miss from "
                     f"{big['miss']['pregame']:.1f} to {big['miss']['roles']:.1f}, mostly from {CAUSES[top]}.")
    for x in it:
        if x["clear"]:
            fix = x["correction"]
            how = (" Watching it; no automatic correction for this input." if not fix else
                   " The next simulations correct for it." if fix["adopted"] else
                   " Its correction is tested on past weeks every update and is used once it helps." if fix.get("gain") is None else
                   " A correction was tested on past weeks and did not help yet, so it is left alone.")
            notes.append(f"{x['label']} keeps running {'above' if x['bias'] > 0 else 'below'} the pregame input "
                         f"({x['bias']:+.1f} {x['unit']} over {x['n']}).{how}")
    out = {"available": True, "created_at": utcnow(), "games": len(games), "pending": pending,
           "weeks": sorted({(g["season"], g["week"]) for g in games}), "last_week": {"season": last[0], "week": last[1]},
           "levels": [{"key": k, "label": lbl} for k, lbl in LEVELS], "markets": mk,
           "markets_last_week": _market_table([r for g in lastg for r in g["rows"]]), "inputs": it,
           "corrections": {"in_use": {k: v for k, v in params.items() if k in ("pass_adj", "rush_adj", *gs.CORRECTIONS)},
                           "tests": corrections},
           "game_cards": [{"game_id": g["game_id"], "matchup": _matchup(g["game_id"]), "teams": g["teams"], "notes": _game_notes(g),
                           "market_miss": {m["market"]: m["miss"] for m in _market_table(g["rows"])}}
                          for g in sorted(lastg, key=lambda g: g.get("kickoff") or "")],
           "biggest_misses": [{k: r[k] for k in ("player", "team", "market", "pre", "actual", "cause", "game_id")} for r in misses],
           "notes": notes}
    log(f"simreview: {len(games)} games re-simulated ({pending} waiting on box scores); " + " ".join(notes[:2]))
    return out


def run(c, log=print) -> dict:
    try:
        rep = report(c, log=log)
    except Exception as ex:  # noqa: BLE001 - the review is extra; the site still builds
        log(f"simreview: skipped ({ex})")
        rep = {"available": False, "created_at": utcnow(), "empty_reason": f"The post-game re-simulation did not run this update ({ex})."}
    paths.results_dir().mkdir(parents=True, exist_ok=True)
    (paths.results_dir() / "sim_report.json").write_text(json.dumps(rep, indent=2, default=float))
    return rep


def latest() -> dict | None:
    f = paths.results_dir() / "sim_report.json"
    return json.loads(f.read_text()) if f.exists() else None


if __name__ == "__main__":
    con = db.connect(paths.db_path())
    print(json.dumps({k: v for k, v in run(con).items() if k in ("available", "games", "pending", "notes")}, indent=2))
