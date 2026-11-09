from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Query

from engine.backtest import wilson

from ..core import get_db, latest_walk_forward, loads

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


def _report(c):
    wf = latest_walk_forward(c)
    return (wf, loads(wf["metrics"], {})) if wf else (None, None)


@router.get("/summary")
def summary(c: sqlite3.Connection = Depends(get_db)):
    wf, m = _report(c)
    if not wf:
        return {"available": False, "empty_reason": "No walk-forward run yet. It runs automatically after a full data import."}
    overall = {k: {kk: vv for kk, vv in v.items() if kk != "calibration"} for k, v in m["overall"].items()}
    return {"available": True, "run_id": wf["run_id"], "created_at": wf["created_at"], "test_weeks": m["test_weeks"],
            "eligible_population": m["eligible_population"], "overall": overall, "by_season": m["by_season"],
            "by_position": m["by_position"], "topn": m["topn"], "gate": m["gate"],
            "method": ["Each test week is predicted by models fit only on player-games from earlier weeks.",
                       "Features use only games before the predicted week; opponent defense splits are recomputed at each cutoff.",
                       "Market spread/total lines come from the nflverse schedule (closing lines for completed games). They are "
                       "public before kickoff but later than a midweek decision, so results may be slightly optimistic.",
                       "Top-N picks come from the pregame pool: weekly roster ACT and not Out/Doubtful on the final injury report. "
                       "A pick who then did not play is void, counted separately.",
                       "xTD conversion rates for season S are learned only from seasons before S."]}


@router.get("/weeks")
def weeks(c: sqlite3.Connection = Depends(get_db)):
    wf, m = _report(c)
    return {"available": bool(wf), "weeks": m["weekly"] if m else []}


@router.get("/calibration")
def calibration(model: str | None = None, c: sqlite3.Connection = Depends(get_db)):
    wf, m = _report(c)
    if not wf:
        return {"available": False}
    names = [model] if model else list(m["overall"].keys())
    return {"available": True, "models": {n: m["overall"][n]["calibration"] for n in names if n in m["overall"]}}


@router.get("/picks")
def picks(model: str | None = None, season: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    wf, m = _report(c)
    if not wf:
        return {"available": False, "picks": []}
    model = model or m["gate"].get("promoted") or "fg-structural-1"
    out = [p for p in m["picks"] if p["model"] == model and (season is None or p["season"] == season)]
    return {"available": True, "model": model, "picks": out}


@router.get("/week-detail")
def week_detail(season: int, week: int, model: str | None = None, limit: int = Query(25, le=200),
                c: sqlite3.Connection = Depends(get_db)):
    """Pregame candidate list for a historical week with realised outcomes (top N by the model)."""
    wf, m = _report(c)
    if not wf:
        return {"available": False, "rows": []}
    model = model or m["gate"].get("promoted") or "fg-structural-1"
    rows = [dict(r) for r in c.execute("""SELECT player_id, player_name, team, position, p, score, outcome, pregame_eligible
                                          FROM backtest_preds WHERE run_id=? AND model=? AND season=? AND week=?
                                          ORDER BY score DESC LIMIT ?""", (wf["run_id"], model, season, week, limit))]
    return {"available": True, "model": model, "season": season, "week": week, "rows": rows}


@router.get("/due")
def due(c: sqlite3.Connection = Depends(get_db)):
    """Do players who have scored fewer TDs than their opportunities predicted bounce back? (engine/due.py)"""
    from engine import due as due_study

    return due_study.latest(c)


@router.get("/live")
def live():
    """Every pick the site suggested, frozen at kickoff and graded after the game (engine/picklog.py)."""
    from engine import picklog

    return picklog.latest()


@router.get("/tuning")
def tuning():
    """Results of the last tuning study (python -m engine.tuning), if one has been run."""
    import json

    from engine import paths

    f = paths.results_dir() / "tuning.json"
    if not f.exists():
        return {"available": False}
    r = json.loads(f.read_text())
    return {"available": True, "created_at": r["created_at"], "selection_weeks": r["selection_weeks"], "holdout_weeks": r["holdout_weeks"],
            "stage_a": [{k: v for k, v in x.items() if k in ("window", "prior_season_weight", "def_shrink_games", "log_loss", "brier",
                                                              "top3_policy_hits", "top3_policy_legs")} for x in r["stage_a"]],
            "stage_b": [{k: v for k, v in x.items() if k in ("added", "accepted", "log_loss", "previous", "all_trials")} for x in r["stage_b"]],
            "c_grid": [{"C": x["C"], "log_loss": x["log_loss"]} for x in r["c_grid"]], "tuned": r["tuned"],
            "comparison": r["comparison"], "adopt": r["adopt"]}


def _line_history(g, min_n: int = 40) -> list[dict]:
    """Group the graded games by line, merging neighbouring lines until each group has min_n games."""
    groups, cur = [], []
    for _, x in g.groupby("line"):
        cur.append(x)
        if sum(len(y) for y in cur) >= min_n:
            groups.append(cur); cur = []
    if cur:
        if groups:
            groups[-1] += cur
        else:
            groups.append(cur)
    out = []
    for parts in groups:
        import pandas as pd  # noqa: PLC0415
        x = pd.concat(parts)
        out.append({"lo": float(x.line.min()), "hi": float(x.line.max()), "n": int(len(x)), "avg_line": float(x.line.mean()),
                    "avg_actual": float(x.actual.mean()), "over_rate": float(x.y.mean()), "avg_p_over": float(x.p_over.mean())})
    return out


# Confidence tiers: plain-language bands with the hit rate of every past walk-forward pick in that band.
TD_TIERS = [("Strong", 0.50, 1.01), ("Solid", 0.35, 0.50), ("Lean", 0.20, 0.35), ("Long shot", 0.0, 0.20)]
PROP_TIERS = [("Strong", 0.65, 1.01), ("Solid", 0.58, 0.65), ("Lean", 0.53, 0.58), ("Coin flip", 0.0, 0.53)]


def _tiers(p, y, bands):
    out = []
    for name, lo, hi in bands:
        m = (p >= lo) & (p < hi)
        n, k = int(m.sum()), int(y[m].sum())
        out.append({"tier": name, "lo": lo, "hi": min(hi, 1.0), "n": n, "hits": k, "rate": k / n if n else None,
                    "avg_chance": float(p[m].mean()) if n else None, "ci": wilson(k, n)})
    return out


@router.get("/confidence")
def confidence(c: sqlite3.Connection = Depends(get_db)):
    import numpy as np  # noqa: PLC0415
    import pandas as pd  # noqa: PLC0415

    from engine import picklog, props  # noqa: PLC0415

    wf = latest_walk_forward(c)
    out = {"td": None, "props": None}
    if wf and wf["model_version"] not in (None, "none"):
        bp = pd.read_sql_query("SELECT season, week, p, outcome FROM backtest_preds WHERE run_id=? AND model=? AND pregame_eligible=1 "
                               "AND outcome IS NOT NULL", c, params=(wf["run_id"], wf["model_version"]))
        if len(bp):
            out["td"] = {"model": wf["model_version"], "weeks": int(bp[["season", "week"]].drop_duplicates().shape[0]),
                         "first_season": int(bp.season.min()), "tiers": _tiers(bp.p.to_numpy(), bp.outcome.to_numpy(), TD_TIERS)}
    rep = props.latest_report(c)
    if rep:
        parts = []
        for market, r in rep["markets"].items():
            model = r["gate"]["promoted"]
            if model:
                parts.append(pd.read_sql_query("SELECT ? AS market, season, week, p_over, line, actual, (actual > line) AS y FROM prop_backtest WHERE run_id=? "
                                               "AND market=? AND model=? AND actual IS NOT NULL", c, params=(market, rep["run_id"], market, model)))
        if parts:
            pb = pd.concat(parts)
            side_p = np.maximum(pb.p_over, 1 - pb.p_over).to_numpy()
            hit = np.where(pb.p_over >= 0.5, pb.y, 1 - pb.y)
            out["props"] = {"weeks": int(pb[["season", "week"]].drop_duplicates().shape[0]), "first_season": int(pb.season.min()),
                            "tiers": _tiers(side_p, hit, PROP_TIERS),
                            # Overs and unders graded separately, overall and per market: is the model as good at calling a shortfall?
                            "by_side": {side: _tiers(side_p[m], hit[m], PROP_TIERS) for side, m in
                                        (("over", (pb.p_over >= 0.5).to_numpy()), ("under", (pb.p_over < 0.5).to_numpy()))},
                            "unders_by_market": [{"market": mk, "label": props.MARKETS[mk]["label"], "n": int(len(g)),
                                                  "hits": int((1 - g.y).sum()), "rate": float(1 - g.y.mean()),
                                                  "avg_chance": float((1 - g.p_over).mean()),
                                                  "strong_n": int((g.p_over <= 0.35).sum()),
                                                  "strong_rate": float(1 - g.y[g.p_over <= 0.35].mean()) if (g.p_over <= 0.35).any() else None}
                                                 for mk, g in pb[pb.p_over < 0.5].groupby("market")],
                            # What players at each usual line actually did next game: shows regression to the mean behind
                            # projections that sit below a player's recent numbers.
                            "line_history": {mk: _line_history(g) for mk, g in pb.groupby("market")},
                            "note": "Prop tiers use the side the model favored at a reference line (the player's recent median), "
                                    "because past sportsbook lines are not available."}
            # chances at book lines re-fit to how leans at book lines have done live (engine/picklog.py); None until it
            # tests better on unseen weeks
            out["props"]["book_calibration"] = picklog.latest().get("book_calibration")
    return out
