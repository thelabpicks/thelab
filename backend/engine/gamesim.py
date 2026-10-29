"""Game simulation: every game played out thousands of times, player by player.

  python -m engine.gamesim            # walk-forward test against the promoted prop models, writes data/results/gamesim.json

Each run of a game draws a final margin from the betting spread, then the team's pass and run volume from its own
recent volume, the opponent, and that game script (teams that fall behind throw more and run less). Targets and
carries are shared out by each player's recent share (with week-to-week wobble), catches and yards come from his own
recent efficiency adjusted for what the defense allows to his position, and the quarterback's line is the sum of
what his receivers did, so every player in a run lives in the same game. Touchdowns follow the team's implied points.

The inputs are the same pregame features the prop models use (engine/props.build_frame: last 8 games, current season
weighted over last season, defenses vs league average from earlier weeks only). The simulation is only used on the
site if, on weeks it never saw, blending it with the promoted model beats the model alone (see blend_test).
"""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd

from . import db, paths, props
from .util import utcnow

N_SIMS = 5000
MARGIN_SD = 13.5          # NFL final margin vs the closing spread
LEAGUE = {"catch_rate": 0.65, "ypr": 10.8, "ypc": 4.3, "int_rate": 0.023, "td_rate": 0.045}
# Tuned on 2021 only (see tune()); evaluation uses 2022 onward.
# On 2021, letting the spread push pass/run volume made the simulation less accurate (team volume already reflects how
# each team plays), so the game-script slopes are 0; the shared volume wobble and share wobble carry the correlation.
# other_min_*: the smallest share left for players outside the frame. The post-game review found a fixed 6% floor took
# about 7% of targets away from the listed receivers, whose shares already sum to about 1 (2% tested better on every
# past week for receiving; carries kept 4%, which tested better than 2%).
# pass_adj / rush_adj: league-wide volume correction learned from recent finished weeks (volume_factor), 1.0 = none.
# fill_car / fill_tgt: when a team's listed players' shares sum to less than 1 (a back or receiver is sitting out), their
# share goes to the players who are playing instead of to "other". Found in the 2026 W7 NE-CHI review (Swift got 22 of 30
# carries with Monangai out; the sim gave him 12). Better simulated log loss for carries, rushing and receiving in every
# season 2021-2026, and a larger blend gain.
# last_car_w: weight on each rusher's share of the team's carries in its previous game (when he played in it), blended
# into his last-8-games share. Found when Jacobs returned (2026 W8 GB: shares summed to 149%); tuned on 2021 (0.3 beat
# 0.2, 0.5 and 1.0), then on 2022-26 carries log loss -0.0068 (week-bootstrap 90% CI -0.0037..-0.0098), rushing yards
# -0.0021 (CI +0.0002..-0.0047); 65%+ carries picks 72.6% -> 73.5%.
# catch_adj / ypt_adj / ypc_adj: league-wide efficiency correction (catch rate, yards per target, yards per carry) learned
# from recent finished weeks (efficiency_factor); used only where run() found it beat the uncorrected simulation.
PARAMS = {"alpha_tgt": 12.0, "alpha_car": 10.0, "k_rec": 0.6, "k_rush": 0.5, "vol_sd": 0.2, "pass_slope": 0.0, "rush_slope": 0.0,
          "script_sd": 0.0, "other_min_tgt": 0.02, "other_min_car": 0.04, "pass_adj": 1.0, "rush_adj": 1.0,
          "fill_car": 1.0, "fill_tgt": 1.0, "catch_adj": 1.0, "ypt_adj": 1.0, "ypc_adj": 1.0, "last_car_w": 0.3}

SIM_MARKETS = ["pass_yards", "pass_attempts", "completions", "pass_tds", "interceptions", "rush_yards", "carries",
               "rec_yards", "receptions", "rush_rec_yards"]


def _num(x, default=0.0) -> np.ndarray:
    a = np.asarray(pd.to_numeric(pd.Series(x), errors="coerce"), dtype=float)
    return np.where(np.isfinite(a), a, default)


def _dirichlet_multinomial(rng, n: np.ndarray, shares: np.ndarray, alpha: float) -> np.ndarray:
    """n: (S,) totals; shares: (P,) expected shares summing to 1 -> (S, P) counts with game-to-game share wobble."""
    p = rng.gamma(np.maximum(shares * alpha, 1e-3), 1.0, size=(len(n), len(shares)))
    p /= p.sum(axis=1, keepdims=True)
    return rng.multinomial(n.astype(np.int64), p)


TEAM = "_team"


def simulate_team(rows: pd.DataFrame, rng, n: int = N_SIMS, params: dict | None = None,
                  with_team: bool = False) -> dict[str, dict[str, np.ndarray]]:
    """Simulate one team's game n times. rows: that team's players for the week (props.build_frame columns).
    Returns {player_id: {stat: (n,) samples}}, plus {TEAM: team attempts, carries, targets} when with_team."""
    P = {**PARAMS, **(params or {})}
    r0 = rows.iloc[0]
    # Game script: the expected margin moves pass/run volume; how far the game actually strays from it (script_sd)
    # is tuned, since a fully random margin adds more noise than it explains.
    exp_margin = float(r0.get("spread_for") or 0.0)
    margin = exp_margin + P["script_sd"] * rng.standard_normal(n)
    vol = np.exp(P["vol_sd"] * rng.standard_normal(n))
    pos = rows.position.to_numpy()

    def pos_mult(col, p):
        sel = rows[rows.position == p][col] if col in rows else pd.Series(dtype=float)
        v = pd.to_numeric(sel, errors="coerce").dropna()
        return float(v.mean()) if len(v) else 1.0

    team_att = float(r0.get("team_attempts_pg") or 33.0) * pos_mult("opp_attempts_mult", "QB")
    team_car = float(r0.get("team_carries_pg") or 26.0) * pos_mult("opp_carries_mult", "RB")
    team_tgt_ratio = float(r0.get("team_targets_pg") or 31.0) / max(float(r0.get("team_attempts_pg") or 33.0), 1.0)
    att = rng.poisson(np.maximum(team_att * P["pass_adj"] * vol * np.exp(P["pass_slope"] * margin / 14.0), 1.0))
    car = rng.poisson(np.maximum(team_car * P["rush_adj"] * vol * np.exp(P["rush_slope"] * margin / 14.0), 1.0))
    # Post-game re-simulation (engine/simreview.py) sets the team's real pass attempts, carries and targets.
    exact = {k: _num([r0.get(k)], np.nan)[0] for k in ("att_exact", "car_exact", "tgt_exact")}
    if np.isfinite(exact["att_exact"]):
        att = np.full(n, int(round(exact["att_exact"])))
        if np.isfinite(exact["tgt_exact"]):
            team_tgt_ratio = exact["tgt_exact"] / max(exact["att_exact"], 1.0)
    if np.isfinite(exact["car_exact"]):
        car = np.full(n, int(round(exact["car_exact"])))
    implied = float(r0.get("team_implied_total") or 22.0)
    out: dict[str, dict[str, np.ndarray]] = {}

    # Receivers: targets shared out, then catches and yards from each player's efficiency vs this defense.
    rec_idx = np.where(np.isin(pos, ["RB", "WR", "TE"]))[0]
    tgt_share = _num(rows.targets_share.iloc[rec_idx]) * _num(rows.opp_targets_mult.iloc[rec_idx], 1.0)
    gap = 1.0 - P["other_min_tgt"] - tgt_share.sum()
    if P["fill_tgt"] > 0 and gap > 0 and tgt_share.sum() > 0:
        tgt_share = tgt_share * (1.0 + P["fill_tgt"] * gap / tgt_share.sum())
    other = max(P["other_min_tgt"], 1.0 - tgt_share.sum())
    shares = np.append(tgt_share, other)
    shares /= shares.sum()
    tgts = _dirichlet_multinomial(rng, np.round(att * team_tgt_ratio), shares, P["alpha_tgt"])
    tot_rec = np.zeros(n)
    tot_yds = np.zeros(n)
    for j, i in enumerate(list(rec_idx) + [None]):
        t = tgts[:, j]
        if i is None:
            cr, ypr = LEAGUE["catch_rate"], LEAGUE["ypr"]
        else:
            r = rows.iloc[i]
            m_rec = _num([r.get("opp_receptions_mult")], 1.0)[0] / max(_num([r.get("opp_targets_mult")], 1.0)[0], 0.5)
            cr = float(np.clip(_num([r.get("catch_rate")], LEAGUE["catch_rate"])[0] * m_rec * P["catch_adj"], 0.2, 0.95))
            base_ypr = _num([r.get("ypt")], 7.5)[0] / max(_num([r.get("catch_rate")], LEAGUE["catch_rate"])[0], 0.2)
            m_yds = _num([r.get("opp_rec_yards_mult")], 1.0)[0] / max(_num([r.get("opp_receptions_mult")], 1.0)[0], 0.5)
            ypr = max(base_ypr * m_yds * P["ypt_adj"] / P["catch_adj"], 2.0)
        rec = rng.binomial(t, cr)
        yds = np.where(rec > 0, rng.gamma(np.maximum(rec, 1) * P["k_rec"], ypr / P["k_rec"]), 0.0)
        tot_rec += rec
        tot_yds += yds
        if i is not None:
            out[rows.iloc[i].player_id] = {"targets": t.astype(float), "receptions": rec.astype(float), "rec_yards": yds}

    # Rushers: carries shared out among the backs and quarterback.
    rush_idx = np.where(np.isin(pos, ["QB", "RB"]))[0]
    car_share = _num(rows.carries_share.iloc[rush_idx])
    if P["last_car_w"] > 0 and "last_carries_share" in rows:
        last = _num(rows.last_carries_share.iloc[rush_idx], np.nan)
        car_share = np.where(np.isfinite(last), P["last_car_w"] * last + (1 - P["last_car_w"]) * car_share, car_share)
    car_share = car_share * _num(rows.opp_carries_mult.iloc[rush_idx], 1.0)
    gap = 1.0 - P["other_min_car"] - car_share.sum()
    if P["fill_car"] > 0 and gap > 0 and car_share.sum() > 0:  # carries left by backs who are not playing go to those who are
        car_share = car_share * (1.0 + P["fill_car"] * gap / car_share.sum())
    other = max(P["other_min_car"], 1.0 - car_share.sum())
    shares = np.append(car_share, other)
    shares /= shares.sum()
    cars = _dirichlet_multinomial(rng, car, shares, P["alpha_car"])
    for j, i in enumerate(rush_idx):
        r = rows.iloc[i]
        ypc = max(_num([r.get("ypc")], LEAGUE["ypc"])[0] * _num([r.get("opp_rush_yards_mult")], 1.0)[0]
                  / max(_num([r.get("opp_carries_mult")], 1.0)[0], 0.5) * P["ypc_adj"], 1.0)
        c_ = cars[:, j]
        yds = np.where(c_ > 0, rng.gamma(np.maximum(c_, 1) * P["k_rush"], ypc / P["k_rush"]), 0.0)
        d = out.setdefault(r.player_id, {})
        d["carries"], d["rush_yards"] = c_.astype(float), yds

    # Passer: the quarterback with the most attempts per game throws them all; his line is his receivers' total.
    qbs = rows[rows.position == "QB"]
    if len(qbs):
        q = qbs.iloc[int(np.argmax(_num(qbs.attempts_pg)))]
        att_pg = max(_num([q.get("attempts_pg")], 30.0)[0], 10.0)
        int_rate = (_num([q.get("interceptions_pg")], 0.0)[0] * 8 + LEAGUE["int_rate"] * att_pg * 4) / (att_pg * 12)
        td_rate = (_num([q.get("pass_tds_pg")], 0.0)[0] * 8 + LEAGUE["td_rate"] * att_pg * 4) / (att_pg * 12)
        ints = rng.poisson(att * int_rate * _num([q.get("opp_interceptions_mult")], 1.0)[0])
        tds = rng.poisson(att * td_rate * _num([q.get("opp_pass_tds_mult")], 1.0)[0] * (implied / 22.5) ** 0.8
                          * np.exp(0.04 * margin / 14.0))
        # Post-game re-simulation with the real efficiency: his actual TD and interception rate per attempt.
        if np.isfinite(_num([q.get("td_rate_exact")], np.nan)[0]):
            tds = rng.poisson(att * float(q.get("td_rate_exact")))
        if np.isfinite(_num([q.get("int_rate_exact")], np.nan)[0]):
            ints = rng.poisson(att * float(q.get("int_rate_exact")))
        d = out.setdefault(q.player_id, {})
        d |= {"attempts": att.astype(float), "completions": tot_rec, "pass_yards": tot_yds, "pass_tds": tds.astype(float),
              "interceptions": ints.astype(float)}
    for d in out.values():
        if "rec_yards" in d or "rush_yards" in d:
            d["rush_rec_yards"] = d.get("rec_yards", 0.0) + d.get("rush_yards", 0.0)
    if with_team:  # the team's own volume, so the post-game review can compare it with what really happened
        out[TEAM] = {"attempts": att.astype(float), "carries": car.astype(float), "targets": tgts.sum(axis=1).astype(float)}
    return out


def simulate_week(week_rows: pd.DataFrame, n: int = N_SIMS, seed: int = 7, params: dict | None = None) -> dict[tuple, dict]:
    """{(player_id, team): {stat: samples}} for every team in the frame rows of one week."""
    rng = np.random.default_rng(seed)
    res = {}
    for team, rows in week_rows.groupby("team"):
        rows = rows[rows.has_history.eq(1)]
        if rows.empty:
            continue
        for pid, d in simulate_team(rows.reset_index(drop=True), rng, n, params).items():
            res[(pid, team)] = d
    return res


def volume_factor(frame: pd.DataFrame, season: int, week: int, k: int = 4) -> dict:
    """How far real team pass attempts and carries ran from the pregame per-game inputs over the last k finished weeks of
    this season (only weeks before `week`, so it never peeks), shrunk toward 1 when few weeks are in. Feeds the next
    pregame simulation: what the post-game review learns, the following week uses."""
    lab = frame[(frame.labelled == 1) & (frame.season == season) & (frame.week < week)]
    wk = sorted(lab.week.unique())[-k:]
    g = lab[lab.week.isin(wk)].groupby(["game_id", "team"]).first()
    if g.empty:
        return {"pass_adj": 1.0, "rush_adj": 1.0}
    f = lambda a, b: float(pd.to_numeric(g[a], errors="coerce").sum() / max(pd.to_numeric(g[b], errors="coerce").sum(), 1.0))  # noqa: E731
    w = len(wk) / (len(wk) + 2.0)
    return {"pass_adj": round(1 + (f("team_attempts", "team_attempts_pg") - 1) * w, 4),
            "rush_adj": round(1 + (f("team_carries", "team_carries_pg") - 1) * w, 4)}


# Efficiency corrections and the markets each is judged on (the stat it moves most directly).
CORRECTIONS = {"catch_adj": ("receptions", "completions"), "ypt_adj": ("rec_yards", "pass_yards"), "ypc_adj": ("rush_yards",)}


def efficiency_factor(frame: pd.DataFrame, season: int, week: int, k: int = 4) -> dict:
    """How far real catch rate, yards per target and yards per carry ran from the players' pregame inputs over the last k
    finished weeks of this season (only weeks before `week`), shrunk toward 1 the same way as volume_factor. These are
    the efficiency inputs the post-game re-simulation checks; run() decides whether correcting them helps."""
    lab = frame[(frame.labelled == 1) & (frame.season == season) & (frame.week < week) & frame.has_history.eq(1)]
    wk = sorted(lab.week.unique())[-k:]
    g = lab[lab.week.isin(wk)]
    if g.empty:
        return {key: 1.0 for key in CORRECTIONS}
    num = lambda col: pd.to_numeric(g[col], errors="coerce").fillna(0.0)  # noqa: E731
    tg, ca = num("targets"), num("carries")

    def ratio(actual, expected):
        e = float(expected.sum())
        return float(actual.sum()) / e if e > 0 else 1.0
    w = len(wk) / (len(wk) + 2.0)
    raw = {"catch_adj": ratio(num("receptions"), tg * num("catch_rate")),
           "ypt_adj": ratio(num("rec_yards"), tg * num("ypt")),
           "ypc_adj": ratio(num("rush_yards"), ca * num("ypc"))}
    return {key: round(1 + (v - 1) * w, 4) for key, v in raw.items()}


def week_params(frame: pd.DataFrame, season: int, week: int, corrections=()) -> dict:
    """What the pregame simulation of a week learns from the weeks before it: the volume correction always, and each
    efficiency correction that was adopted."""
    eff = efficiency_factor(frame, season, week) if corrections else {}
    return {**volume_factor(frame, season, week), **{key: v for key, v in eff.items() if key in corrections}}


def _logit(p):
    p = np.clip(np.asarray(p, float), 0.005, 0.995)  # same clip as the site's pOver
    return np.log(p / (1 - p))


def blend_p(model_p: float, sim: dict, line: float) -> float:
    """Blended chance of the over (same rule as frontend pOver with dist.sim)."""
    q = np.asarray(sim["q"], float)
    p_sim = float(np.clip((q > line).mean(), 0.005, 0.995))
    w = sim["w"]
    z = w[0] * _logit(model_p) + w[1] * _logit(p_sim) + w[2]
    return float(np.clip(1 / (1 + np.exp(-z)), 0.005, 0.995))


def fit_weights(D: pd.DataFrame) -> list[float]:
    from sklearn.linear_model import LogisticRegression  # noqa: PLC0415
    fit = LogisticRegression(C=1.0).fit(np.c_[_logit(D.p_over), _logit(D.p_sim)], D.y)
    return [float(fit.coef_[0][0]), float(fit.coef_[0][1]), float(fit.intercept_[0])]


def _ll(y, p):
    p = np.clip(p, 1e-3, 1 - 1e-3)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def sim_over(frame: pd.DataFrame, bt: pd.DataFrame, weeks, n=N_SIMS, params=None, corrections=()) -> pd.DataFrame:
    """Simulated chance of the over at each backtest row's reference line, one week at a time, pregame features only."""
    lab = frame[frame.labelled == 1]
    out = []
    for s, w in weeks:
        rows = lab[(lab.season == s) & (lab.week == w)]
        sims = simulate_week(rows, n, seed=s * 100 + w, params={**(params or {}), **week_params(frame, s, w, corrections)})
        b = bt[(bt.season == s) & (bt.week == w)].copy()
        p = np.full(len(b), np.nan)
        for k, r in enumerate(b.itertuples(index=False)):
            d = sims.get((r.player_id, r.team))
            st = props.MARKETS[r.market]["stat"]
            if d is not None and st in d:
                p[k] = float((d[st] > r.line).mean())
        b["p_sim"] = p
        out.append(b)
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def _backtest_rows(c) -> pd.DataFrame:
    rep = props.latest_report(c)
    parts = []
    for market, r in rep["markets"].items():
        model = r["gate"]["promoted"]
        if model:
            parts.append(pd.read_sql_query("SELECT ? AS market, season, week, player_id, team, line, p_over, actual FROM prop_backtest "
                                           "WHERE run_id=? AND market=? AND model=? AND actual IS NOT NULL", c,
                                           params=(market, rep["run_id"], market, model)))
    bt = pd.concat(parts, ignore_index=True)
    bt["y"] = (bt.actual > bt.line).astype(int)
    return bt


def blend_test(D: pd.DataFrame, first_eval: int = 2022) -> dict:
    """Walk-forward stacking per market: logistic on logit(model) and logit(sim), fit on earlier weeks only."""
    from sklearn.linear_model import LogisticRegression  # noqa: PLC0415
    lg = _logit
    D = D.dropna(subset=["p_sim"]).sort_values(["season", "week"]).reset_index(drop=True)
    res = {}
    for market, g in D.groupby("market"):
        g = g.reset_index(drop=True)
        g["p_blend"] = np.nan
        weeks = g[["season", "week"]].drop_duplicates().values.tolist()
        for s, w in weeks:
            if s < first_eval:
                continue
            tr = g[(g.season < s) | ((g.season == s) & (g.week < w))]
            te = (g.season == s) & (g.week == w)
            if len(tr) < 500:
                continue
            X = np.c_[lg(tr.p_over), lg(tr.p_sim)]
            fit = LogisticRegression(C=1.0).fit(X, tr.y)
            g.loc[te, "p_blend"] = fit.predict_proba(np.c_[lg(g.loc[te, "p_over"]), lg(g.loc[te, "p_sim"])])[:, 1]
            coef = fit.coef_[0].tolist()
        e = g.dropna(subset=["p_blend"])
        if e.empty:
            continue
        ll_m, ll_s, ll_b = _ll(e.y, e.p_over).mean(), _ll(e.y, e.p_sim).mean(), _ll(e.y, e.p_blend).mean()
        # Paired bootstrap by week for the blend's gain over the model alone.
        wk = e.groupby(["season", "week"]).apply(lambda x: (_ll(x.y, x.p_over) - _ll(x.y, x.p_blend)).sum() / 1.0).to_numpy()
        nwk = e.groupby(["season", "week"]).size().to_numpy()
        rng = np.random.default_rng(1)
        boots = []
        for _ in range(300):
            i = rng.integers(0, len(wk), len(wk))
            boots.append(wk[i].sum() / nwk[i].sum())
        lo, hi = np.percentile(boots, [5, 95])

        def hits(p):  # the side each source favors, among picks it rates 65%+
            side = np.maximum(p, 1 - p)
            m = side >= 0.65
            hit = np.where(p >= 0.5, e.y, 1 - e.y)
            return {"n": int(m.sum()), "rate": float(hit[m].mean()) if m.any() else None}
        res[market] = {"n": int(len(e)), "weeks": int(e[["season", "week"]].drop_duplicates().shape[0]),
                       "log_loss_model": float(ll_m), "log_loss_sim": float(ll_s), "log_loss_blend": float(ll_b),
                       "gain": float(ll_m - ll_b), "gain_ci90": [float(lo), float(hi)], "adopt": bool(lo > 0),
                       "last_weights": coef, "strong_model": hits(e.p_over.to_numpy()), "strong_sim": hits(e.p_sim.to_numpy()),
                       "strong_blend": hits(e.p_blend.to_numpy())}
    return res


def correction_test(frame: pd.DataFrame, bt: pd.DataFrame, weeks, n: int = 1000, log=print) -> dict:
    """Walk-forward check of each efficiency correction: the same weeks simulated with and without it (same random
    draws), judged by log loss on the markets it moves. Adopted only when the 90% interval of the gain, resampled by
    week, is above zero; otherwise the next simulation leaves that input alone."""
    keys = list(CORRECTIONS)
    a = sim_over(frame, bt, weeks, n=n)
    b = sim_over(frame, bt, weeks, n=n, corrections=keys)
    D = a.assign(p_fix=b.p_sim.to_numpy()).dropna(subset=["p_sim", "p_fix"])
    out = {}
    for key, markets in CORRECTIONS.items():
        e = D[D.market.isin(markets)]
        if e.empty:
            continue
        gain = _ll(e.y, e.p_sim) - _ll(e.y, e.p_fix)
        wk = gain.groupby([e.season, e.week]).sum().to_numpy()
        nwk = e.groupby(["season", "week"]).size().to_numpy()
        rng = np.random.default_rng(2)
        boots = [wk[i].sum() / nwk[i].sum() for i in (rng.integers(0, len(wk), len(wk)) for _ in range(300))]
        lo, hi = np.percentile(boots, [5, 95])
        out[key] = {"markets": list(markets), "n": int(len(e)), "weeks": int(len(wk)), "gain": float(gain.mean()),
                    "gain_ci90": [float(lo), float(hi)], "adopt": bool(lo > 0)}
        log(f"gamesim correction {key}: gain {gain.mean():+.4f} ci90 [{lo:+.4f},{hi:+.4f}] adopt={lo > 0}")
    return out


CORRECTION_SEASONS = 2   # the correction test looks at the most recent seasons only (it reruns every update)


def adopted_corrections(rep: dict | None = None) -> list[str]:
    rep = latest() if rep is None else rep
    return [k for k, r in ((rep or {}).get("corrections") or {}).items() if r.get("adopt")]


def run(c, frame: pd.DataFrame | None = None, log=print, n: int = 2000) -> dict:
    """Walk-forward test of the simulation on every backtest week, then the blend weights for markets where it helped.
    Rerun each update, so the weights keep learning from every newly finished week. First the efficiency corrections
    the post-game review measures are tested on recent weeks; the ones that help are used in every simulation after."""
    frame = props.build_frame(c) if frame is None else frame
    bt = _backtest_rows(c)
    weeks = bt[["season", "week"]].drop_duplicates().sort_values(["season", "week"]).values.tolist()
    recent = [w for w in weeks if w[0] > max(s for s, _ in weeks) - CORRECTION_SEASONS] if weeks else []
    log(f"gamesim: testing efficiency corrections on {len(recent)} recent weeks")
    corrections = correction_test(frame, bt, recent, log=log) if recent else {}
    use = [k for k, r in corrections.items() if r["adopt"]]
    log(f"gamesim: simulating {len(weeks)} past weeks, {n} runs per game")
    D = sim_over(frame, bt, weeks, n=n, corrections=use).dropna(subset=["p_sim"])
    rep = {"created_at": utcnow(), "sims_per_game": n, "params": PARAMS, "corrections": corrections, "markets": blend_test(D)}
    for m, r in rep["markets"].items():
        if r["adopt"]:
            r["weights"] = fit_weights(D[D.market == m])
    for m, r in rep["markets"].items():
        log(f"gamesim {m}: model {r['log_loss_model']:.4f} sim {r['log_loss_sim']:.4f} blend {r['log_loss_blend']:.4f} "
            f"gain {r['gain']:+.4f} ci90 [{r['gain_ci90'][0]:+.4f},{r['gain_ci90'][1]:+.4f}] adopt={r['adopt']}")
    paths.results_dir().mkdir(parents=True, exist_ok=True)
    (paths.results_dir() / "gamesim.json").write_text(json.dumps(rep, indent=2, default=float))
    return rep


REVIEW_STATS = {"receptions": "receptions", "rec_yards": "rec_yards", "rush_yards": "rush_yards", "carries": "carries",
                "pass_yards": "pass_yards", "completions": "completions", "pass_attempts": "attempts"}


def _postgame_rows(rows: pd.DataFrame, level: str) -> pd.DataFrame:
    """The same players with what actually happened swapped in: 'volume' = each team's real pass attempts, carries and
    targets; 'role' = that plus each player's real share of them. Whatever error is left after 'role' is efficiency
    (yards per catch or carry, catch rate) and plain chance."""
    r = rows.copy()
    num = lambda col: pd.to_numeric(r[col], errors="coerce")  # noqa: E731
    for pg, act in (("team_attempts_pg", "team_attempts"), ("team_carries_pg", "team_carries"), ("team_targets_pg", "team_targets")):
        r[pg] = num(act).fillna(num(pg))
    r["opp_attempts_mult"] = 1.0
    if level == "role":
        r["targets_share"] = (num("targets") / num("team_targets").replace(0, np.nan)).fillna(0.0)
        r["carries_share"] = (num("carries") / num("team_carries").replace(0, np.nan)).fillna(0.0)
        r["last_carries_share"] = np.nan  # the real share replaces the pregame blend
        r["attempts_pg"] = num("attempts").fillna(num("attempts_pg"))
        r["opp_targets_mult"] = 1.0
        r["opp_carries_mult"] = 1.0
    return r


def review(c, frame: pd.DataFrame | None = None, season: int | None = None, weeks: int = 4, n: int = 2000, log=print) -> dict:
    """Post-game check of the simulation: rerun each finished week with the real team volume, then also the real player
    roles, and compare each against the pregame run. Shows where the pregame inputs were off, market by market."""
    frame = props.build_frame(c) if frame is None else frame
    lab = frame[(frame.labelled == 1) & frame.has_history.eq(1)]
    season = season or int(lab.season.max())
    done = sorted(lab[lab.season == season].week.unique())[-weeks:]
    params = {**PARAMS, "vol_sd": 0.0}
    per: dict[str, dict[str, list[float]]] = {}
    vol = {"pass": [], "rush": []}
    for w in done:
        rows = lab[(lab.season == season) & (lab.week == w)]
        runs = {"pregame": simulate_week(rows, n, seed=season * 100 + w, params=volume_factor(frame, season, w))}
        for level in ("volume", "role"):
            runs[level] = simulate_week(_postgame_rows(rows, level), n, seed=season * 100 + w, params=params)
        for t, g in rows.groupby("team"):
            g0 = g.iloc[0]
            vol["pass"].append(float(pd.to_numeric(g0.team_attempts, errors="coerce")) - float(g0.team_attempts_pg or 0))
            vol["rush"].append(float(pd.to_numeric(g0.team_carries, errors="coerce")) - float(g0.team_carries_pg or 0))
        for r in rows.itertuples(index=False):
            for m, st in REVIEW_STATS.items():
                actual = pd.to_numeric(getattr(r, st, np.nan), errors="coerce")
                d0 = runs["pregame"].get((r.player_id, r.team), {})
                if pd.isna(actual) or st not in d0 or (m in ("pass_yards", "completions", "pass_attempts") and r.position != "QB"):
                    continue
                if m not in ("pass_yards", "completions", "pass_attempts") and float(np.median(d0[st])) < 1:
                    continue  # players with no real role add noise, not insight
                e = per.setdefault(m, {"pregame": [], "volume": [], "role": [], "bias": []})
                for level in ("pregame", "volume", "role"):
                    dl = runs[level].get((r.player_id, r.team), {})
                    if st in dl:
                        e[level].append(abs(float(np.median(dl[st])) - float(actual)))
                e["bias"].append(float(actual) - float(np.median(d0[st])))
    markets = {}
    for m, e in per.items():
        k = min(len(e["pregame"]), len(e["volume"]), len(e["role"]))
        if k < 30:
            continue
        a, b, c_ = (float(np.mean(e[x][:k])) for x in ("pregame", "volume", "role"))
        total = max(a, 1e-9)
        markets[m] = {"label": props.MARKETS[m]["label"], "n": k, "miss_pregame": round(a, 2), "miss_real_volume": round(b, 2),
                      "miss_real_role": round(c_, 2), "bias": round(float(np.mean(e["bias"])), 2),
                      "share_volume": round(max(a - b, 0) / total, 3), "share_role": round(max(b - c_, 0) / total, 3),
                      "share_efficiency": round(c_ / total, 3)}
    vol_bias = {k: round(float(np.nanmean(v)), 1) for k, v in vol.items() if v}
    biggest = max(markets.items(), key=lambda kv: kv[1]["share_volume"] + kv[1]["share_role"], default=None)
    notes = []
    if vol_bias:
        notes.append(f"Teams threw {abs(vol_bias['pass']):.1f} {'more' if vol_bias['pass'] > 0 else 'fewer'} passes and ran {abs(vol_bias['rush']):.1f} "
                     f"{'more' if vol_bias['rush'] > 0 else 'fewer'} times per game than the pregame inputs said.")
    if biggest:
        m, x = biggest
        notes.append(f"{x['label']}: knowing the real volume and roles would have cut the typical miss from {x['miss_pregame']} to {x['miss_real_role']}; "
                     f"the rest ({x['share_efficiency']:.0%}) is efficiency and chance.")
    rep = {"created_at": utcnow(), "season": season, "weeks": [int(w) for w in done], "sims_per_game": n, "volume_bias": vol_bias,
           "markets": markets, "notes": notes}
    log(f"gamesim review: weeks {rep['weeks']} " + "; ".join(notes))
    paths.results_dir().mkdir(parents=True, exist_ok=True)
    (paths.results_dir() / "gamesim_review.json").write_text(json.dumps(rep, indent=2, default=float))
    return rep


def latest_review() -> dict | None:
    f = paths.results_dir() / "gamesim_review.json"
    return json.loads(f.read_text()) if f.exists() else None


def latest() -> dict | None:
    f = paths.results_dir() / "gamesim.json"
    return json.loads(f.read_text()) if f.exists() else None


def attach(c, frame: pd.DataFrame, season: int, week: int, run_id: str, log=print, n: int = N_SIMS) -> dict:
    """Simulate the upcoming week and add the simulation to each projection in a market where the blend was adopted."""
    rep = latest()
    adopted = {m: r["weights"] for m, r in (rep or {}).get("markets", {}).items() if r.get("adopt") and r.get("weights")}
    rows = frame[(frame.season == season) & (frame.week == week)]
    # Past weeks only hold players who suited up, so players ruled out (inactive or Out/Doubtful) sit out here too and
    # their share goes to the rest, as in the walk-forward test.
    st_ = rows["status"] if "status" in rows else pd.Series(index=rows.index, dtype=object)
    rs_ = rows["report_status"] if "report_status" in rows else pd.Series(index=rows.index, dtype=object)
    out_ = (st_.notna() & st_.ne("ACT")) | rs_.isin(props.PASS_ON)
    rows = rows[~out_]
    adj = week_params(frame, season, week, adopted_corrections(rep))
    sims = simulate_week(rows, n, seed=season * 100 + week, params=adj)
    log(f"gamesim: corrections from recent weeks: " + ", ".join(f"{k} x{v}" for k, v in adj.items()))
    try:  # frozen at kickoff for the post-game re-simulation; never stops the site
        from . import simreview  # noqa: PLC0415
        simreview.freeze(c, rows, season, week, adj, n=n, log=log)
    except Exception as ex:  # noqa: BLE001
        log(f"simreview: pregame sims not frozen ({ex})")
    qs = np.arange(1, 100)
    updates, count = [], {}
    for r in c.execute("SELECT market, player_id, team, dist FROM prop_projections WHERE run_id=? AND calibrated=1", (run_id,)).fetchall():
        d = sims.get((r["player_id"], r["team"]))
        st = props.MARKETS[r["market"]]["stat"]
        if r["market"] not in adopted or d is None or st not in d or not r["dist"]:
            continue
        dist = json.loads(r["dist"])
        dist["sim"] = {"q": [round(float(x), 2) for x in np.percentile(d[st], qs)], "w": adopted[r["market"]],
                       "median": float(np.median(d[st])), "runs": n}
        updates.append((json.dumps(dist), run_id, r["market"], r["player_id"]))
        count[r["market"]] = count.get(r["market"], 0) + 1
    with c:
        c.executemany("UPDATE prop_projections SET dist=? WHERE run_id=? AND market=? AND player_id=?", updates)
    log(f"gamesim: {n} runs per game for {season} W{week}; blended into " + (", ".join(f"{k} {v}" for k, v in count.items()) or "no markets"))
    return count


if __name__ == "__main__":
    run(db.connect(paths.db_path()))
