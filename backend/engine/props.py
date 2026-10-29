"""Player prop projections (yards, volume, passing) with full predictive distributions.

Same discipline as the anytime-TD engine:
  * every feature for week N uses games before week N only (defense and team context at each week's cutoff);
  * each test week is projected by models fit only on earlier player-games (walk-forward);
  * a market shows "chance of going over" only after its promoted model beats both baselines on
    unseen weeks (CRPS with a week-bootstrap CI, over/under Brier at a reference line) and its
    over/under probabilities and 10-90% ranges are calibrated. Otherwise it stays a research projection.

No historical sportsbook prop lines are available in nflverse, so the backtest's over/under check uses a
reference line built from the player's own recent median (floor + 0.5), not a market line.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from collections import defaultdict, deque

import numpy as np
import pandas as pd
from scipy import stats as sps
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .util import utcnow

WINDOW = 8
PRIOR_SEASON_WEIGHT = 0.5
DEF_SHRINK_GAMES = 4.0
TEAM_SHRINK_GAMES = 3.0
PLAYER_SHRINK_GAMES = 2.0
RECENCY_HALF_LIFE: float | None = None  # seasons; see engine/recency.py
QUANTS = np.arange(1, 100) / 100.0  # stored predictive quantiles (1%..99%)

STATS = ["attempts", "completions", "pass_yards", "pass_tds", "interceptions", "carries", "rush_yards", "targets",
         "receptions", "rec_yards", "rush_rec_yards"]

# market -> definition. kind "count" uses a negative binomial (small, overdispersed counts); "empirical" uses the
# scaled residuals of held-out games (yards, and pass attempts/completions, which vary less than a Poisson count).
MARKETS = {
    "pass_yards": {"label": "Passing yards", "stat": "pass_yards", "kind": "empirical", "positions": ("QB",), "volume": "attempts"},
    "pass_attempts": {"label": "Pass attempts", "stat": "attempts", "kind": "empirical", "positions": ("QB",), "volume": "attempts"},
    "completions": {"label": "Completions", "stat": "completions", "kind": "empirical", "positions": ("QB",), "volume": "attempts"},
    "pass_tds": {"label": "Passing TDs", "stat": "pass_tds", "kind": "count", "positions": ("QB",), "volume": "attempts"},
    "interceptions": {"label": "Interceptions thrown", "stat": "interceptions", "kind": "count", "positions": ("QB",), "volume": "attempts"},
    "rush_yards": {"label": "Rushing yards", "stat": "rush_yards", "kind": "empirical", "positions": ("QB", "RB"), "volume": "carries"},
    "carries": {"label": "Rush attempts", "stat": "carries", "kind": "count", "positions": ("QB", "RB"), "volume": "carries"},
    "rec_yards": {"label": "Receiving yards", "stat": "rec_yards", "kind": "empirical", "positions": ("RB", "WR", "TE"), "volume": "targets"},
    "receptions": {"label": "Receptions", "stat": "receptions", "kind": "count", "positions": ("RB", "WR", "TE"), "volume": "targets"},
    "rush_rec_yards": {"label": "Rush + receiving yards", "stat": "rush_rec_yards", "kind": "empirical", "positions": ("RB", "WR", "TE"),
                       "volume": "touches"},
}
# Who gets a projection: enough recent volume to be priced by a sportsbook.
VOLUME_RULES = {"attempts": ("attempts_pg", 15.0), "carries": ("carries_pg", 4.0), "targets": ("targets_pg", 2.5),
                "touches": ("touches_pg", 6.0)}

GATE = {
    "min_test_rows": 500,
    "min_test_weeks": 10,
    "bootstrap_reps": 300,
    "max_ece": 0.03,  # or the 95th percentile of ECE expected from sampling noise alone, if larger
    "coverage_tolerance": 0.04,  # observed share inside the 10-90% range vs the share the model itself expects
    "parsimony_tolerance": 0.005,  # relative CRPS: prefer the simpler model when within 0.5%
}
CANDIDATES = ["props-glm-1", "props-gbm-1"]
BASELINES = ["baseline-player-avg", "baseline-position-avg"]
PASS_ON = {"Out", "Doubtful"}
# "Players like him vs this defense": how players of the same position and a similar role (thirds of their own pregame
# volume) did against this defense compared with their own averages, this season's earlier weeks only, shrunk toward
# 1. Walk-forward 2024-26 (2026-10-29): better passing yards (CRPS -0.9%, week-bootstrap 90% CI -0.3..-1.5%) and
# receptions (-0.1%, CI 0.0..-0.2%); rushing (-0.3%, CI +0.1..-0.7%) and receiving yards (0.0%) did not prove out.
SIMILAR_STATS = {"pass_yards": ("pass_yards", "attempts"), "receptions": ("receptions", "targets")}
SIMILAR_VOLUME = {"QB": "attempts_pg", "RB": "touches_pg", "WR": "targets_pg", "TE": "targets_pg"}
SIMILAR_SHRINK_GAMES = 4.0


def _df(c, sql, params=()):
    return pd.read_sql_query(sql, c, params=params)


# --------------------------------------------------------------------------- data
def load_history(c: sqlite3.Connection) -> pd.DataFrame:
    """Participated player-games with box-score stats (zero when the player had no box-score row)."""
    pg = _df(c, "SELECT season, week, game_id, player_id, player_name, position, team, opponent, offense_pct "
                "FROM player_game WHERE participated=1 AND position IN ('QB','RB','WR','TE')")
    pw = _df(c, "SELECT season, week, player_id, team, attempts, completions, pass_yards, pass_tds, interceptions, "
                "carries, rush_yards, targets, receptions, rec_yards FROM player_week")
    h = pg.merge(pw, on=["season", "week", "player_id", "team"], how="left")
    for col in STATS[:-1]:
        h[col] = pd.to_numeric(h[col], errors="coerce").fillna(0.0)
    h["rush_rec_yards"] = h.rush_yards + h.rec_yards
    return h.sort_values(["season", "week"]).reset_index(drop=True)


def game_context(c: sqlite3.Connection) -> pd.DataFrame:
    g = _df(c, "SELECT game_id, season, week, home_team, away_team, gameday, gametime, spread_line, total_line, home_score FROM games "
               "WHERE game_type='REG' OR game_type IS NULL")
    rows = []
    for side, opp, home in (("home_team", "away_team", 1), ("away_team", "home_team", 0)):
        x = g.rename(columns={side: "team", opp: "opponent"})[["game_id", "season", "week", "team", "opponent", "gameday", "gametime",
                                                              "spread_line", "total_line", "home_score"]].copy()
        x["is_home"] = home
        sign = 1 if home else -1
        x["team_implied_total"] = (x.total_line + sign * x.spread_line) / 2
        x["opp_implied_total"] = (x.total_line - sign * x.spread_line) / 2
        rows.append(x)
    out = pd.concat(rows, ignore_index=True)
    out["game_completed"] = out.home_score.notna().astype(int)
    return out.drop(columns=["home_score"])


# --------------------------------------------------------------------------- features
def build_frame(c: sqlite3.Connection, upcoming: pd.DataFrame | None = None) -> pd.DataFrame:
    """One row per (player, team, season, week): participated games (labelled) plus optional upcoming rows."""
    hist = load_history(c)
    ctx = game_context(c)
    team_tot = hist.groupby(["season", "week", "team"])[["attempts", "carries", "targets"]].sum().add_prefix("team_").reset_index()
    hist = hist.merge(team_tot, on=["season", "week", "team"], how="left")
    labelled = hist.copy()
    labelled["labelled"] = 1
    rows = [labelled]
    if upcoming is not None and len(upcoming):
        u = upcoming.copy()
        u["labelled"] = 0
        rows.append(u)
    t = pd.concat(rows, ignore_index=True)
    t = t.merge(ctx.drop(columns=["opponent"]).rename(columns={"game_id": "ctx_game"}), on=["season", "week", "team"], how="left")
    t["game_id"] = t.game_id.fillna(t.ctx_game) if "game_id" in t else t.ctx_game
    t = t.drop(columns=["ctx_game"])
    t["spread_for"] = t.team_implied_total - t.opp_implied_total
    feats = _player_windows(hist, t)
    t = t.join(feats)
    t = t.join(_team_volume(hist, t))
    t = t.join(_defense(hist, t))
    t = t.join(_defense_similar(t))
    t = t.join(_last_carries_share(hist, t))
    return t


def _player_windows(hist: pd.DataFrame, t: pd.DataFrame) -> pd.DataFrame:
    by_player = defaultdict(list)
    for r in hist.itertuples(index=False):
        by_player[r.player_id].append(r)
    out = {}
    order = t.sort_values(["season", "week"])
    for pid, rows in order.groupby("player_id", sort=False):
        games = by_player.get(pid, [])
        gi = 0
        win: deque = deque(maxlen=WINDOW)
        cur: dict = defaultdict(list)
        for idx, r in zip(rows.index, rows.itertuples(index=False)):
            while gi < len(games) and (games[gi].season, games[gi].week) < (r.season, r.week):
                win.append(games[gi])
                cur[games[gi].season].append(games[gi])
                gi += 1
            out[idx] = _window_features(win, cur.get(r.season, []), r)
    return pd.DataFrame.from_dict(out, orient="index")


def _window_features(win, cur, r) -> dict:
    if not win:
        return {"has_history": 0, "n_games_window": 0, "n_games_cur": 0}
    w = np.array([1.0 if g.season == r.season else PRIOR_SEASON_WEIGHT for g in win])
    ws = w.sum()
    f = {"has_history": 1, "n_games_window": len(win), "n_games_cur": len(cur), "eff_games": float(ws)}
    for s in STATS:
        vals = np.array([getattr(g, s) for g in win], dtype=float)
        f[f"{s}_pg"] = float((w * vals).sum() / ws)
        f[f"{s}_med"] = float(np.median(vals))
        f[f"{s}_l3"] = float(vals[-3:].mean())
        f[f"{s}_cur"] = float(np.mean([getattr(g, s) for g in cur])) if cur else np.nan
        f[f"{s}_last"] = float(vals[-1])
    f["touches_pg"] = f["carries_pg"] + f["targets_pg"]
    for num, den in (("targets", "team_targets"), ("carries", "team_carries"), ("attempts", "team_attempts")):
        n = sum(wi * getattr(g, num) for wi, g in zip(w, win))
        d = sum(wi * (getattr(g, den) or 0) for wi, g in zip(w, win))
        f[f"{num}_share"] = float(n / d) if d else np.nan
    snaps = [(wi, g.offense_pct) for wi, g in zip(w, win) if g.offense_pct == g.offense_pct and g.offense_pct is not None]
    f["snap_pct"] = float(sum(a * b for a, b in snaps) / sum(a for a, _ in snaps)) if snaps else np.nan
    # Efficiency, shrunk toward typical values so a few big plays do not dominate.
    f["ypa"] = float((f["pass_yards_pg"] * ws + 6.8 * 60) / (f["attempts_pg"] * ws + 60))
    f["comp_pct"] = float((f["completions_pg"] * ws + 0.64 * 60) / (f["attempts_pg"] * ws + 60))
    f["ypc"] = float((f["rush_yards_pg"] * ws + 4.2 * 30) / (f["carries_pg"] * ws + 30))
    f["ypt"] = float((f["rec_yards_pg"] * ws + 7.5 * 30) / (f["targets_pg"] * ws + 30))
    f["catch_rate"] = float((f["receptions_pg"] * ws + 0.65 * 30) / (f["targets_pg"] * ws + 30))
    last = win[-1]
    f["changed_team"] = int(last.team != r.team)
    f["last_season"], f["last_week"] = int(last.season), int(last.week)
    return f


def _team_volume(hist: pd.DataFrame, t: pd.DataFrame) -> pd.DataFrame:
    tg = hist.groupby(["season", "week", "team"])[["attempts", "carries", "targets"]].sum().reset_index()
    league = tg.groupby("season")[["attempts", "carries", "targets"]].mean()
    res = {}
    groups = {k: g for k, g in tg.groupby(["season", "team"])}
    for s, wk, tm in t[["season", "week", "team"]].drop_duplicates().itertuples(index=False):
        prior = groups.get((s, tm))
        prior = prior[prior.week < wk] if prior is not None else tg.iloc[0:0]
        lg = league.loc[s - 1] if (s - 1) in league.index else league.iloc[0]
        n = len(prior)
        res[(s, wk, tm)] = {f"team_{k}_pg": float((prior[k].sum() + TEAM_SHRINK_GAMES * lg[k]) / (n + TEAM_SHRINK_GAMES))
                            for k in ("attempts", "carries", "targets")}
    tf = pd.DataFrame.from_dict(res, orient="index")
    tf.index = pd.MultiIndex.from_tuples(tf.index, names=["season", "week", "team"])
    return t[["season", "week", "team"]].join(tf, on=["season", "week", "team"]).drop(columns=["season", "week", "team"])


def _defense(hist: pd.DataFrame, t: pd.DataFrame) -> pd.DataFrame:
    """Opponent stats allowed to the player's position per game, prior weeks of the season only, vs league average."""
    d = hist.groupby(["season", "week", "opponent", "position"])[STATS].sum().reset_index()
    dgames = hist.groupby(["season", "opponent"]).week.apply(lambda s: sorted(set(s))).to_dict()
    res = {}
    for (s, wk), rows in t.groupby(["season", "week"]):
        prior = d[(d.season == s) & (d.week < wk)]
        if prior.empty:
            continue
        total_games = prior.groupby("opponent").week.nunique()
        lg = prior.groupby("position")[STATS].sum() / max(total_games.sum(), 1)
        agg = prior.groupby(["opponent", "position"])[STATS].sum()
        for idx, opp, pos in rows[["opponent", "position"]].itertuples():
            if pos not in lg.index or not isinstance(opp, str):
                continue
            n = len([x for x in dgames.get((s, opp), []) if x < wk])
            have = (opp, pos) in agg.index
            f = {"opp_def_games": n}
            for st in ("pass_yards", "attempts", "completions", "pass_tds", "interceptions", "rush_yards", "carries", "rec_yards",
                       "receptions", "targets", "rush_rec_yards"):
                base = float(lg.loc[pos, st])
                tot = float(agg.loc[(opp, pos), st]) if have else 0.0
                f[f"opp_{st}_mult"] = ((tot + DEF_SHRINK_GAMES * base) / (n + DEF_SHRINK_GAMES)) / base if base > 0 else 1.0
            res[idx] = f
    return pd.DataFrame.from_dict(res, orient="index")


def _role_tier(t: pd.DataFrame) -> pd.Series:
    """0/1/2: bottom, middle or top third of the position by the player's own pregame volume. Cut points come from
    earlier seasons."""
    vol = pd.Series(np.nan, index=t.index)
    for pos, col in SIMILAR_VOLUME.items():
        if col in t:
            vol[t.position == pos] = t.loc[t.position == pos, col]
    tier = pd.Series(1, index=t.index)
    ok = t.labelled.eq(1) & vol.notna()
    for s in t.season.unique():
        ref = t[ok & (t.season < s)]
        if ref.empty:  # first season on file: everyone in the middle tier (no later games leak into the cut points)
            continue
        cut = vol[ref.index].groupby(ref.position).quantile([1 / 3, 2 / 3]).unstack()
        cur = t.season == s
        lo, hi = t.position[cur].map(cut[1 / 3]), t.position[cur].map(cut[2 / 3])
        tier[cur] = np.where(vol[cur] >= hi, 2, np.where(vol[cur] >= lo, 1, 0))
    return tier


def _defense_similar(t: pd.DataFrame) -> pd.DataFrame:
    """opp_sim_{stat}_mult: what players of the same position and role tier got against this defense, relative to their
    own pregame averages ({stat}_pg), over the defense's earlier weeks this season. 1.0 = they did their usual."""
    stats = sorted({x for v in SIMILAR_STATS.values() for x in v})
    tier = _role_tier(t)
    keys = ["opponent", "position", "tier"]
    lab = t[t.labelled.eq(1) & t.has_history.eq(1)].assign(tier=tier)
    agg_cols = {}
    for st in stats:
        lab[f"exp_{st}"] = lab[f"{st}_pg"].fillna(0.0)
        agg_cols[st] = st
    g = lab.groupby(["season", "week"] + keys)[stats + [f"exp_{x}" for x in stats]].sum().reset_index()
    tt = t.assign(tier=tier)
    res = {}
    for (s, wk), rows in tt.groupby(["season", "week"]):
        prior = g[(g.season == s) & (g.week < wk)]
        if prior.empty:
            continue
        agg = prior.groupby(keys)[stats + [f"exp_{x}" for x in stats]].sum()
        per_game = prior[[f"exp_{x}" for x in stats]].sum() / max(len(prior), 1)
        for idx, key in zip(rows.index, rows[keys].itertuples(index=False, name=None)):
            have = key in agg.index
            f = {}
            for st in stats:
                prior_mass = SIMILAR_SHRINK_GAMES * float(per_game[f"exp_{st}"])
                a = float(agg.loc[key, st]) if have else 0.0
                e = float(agg.loc[key, f"exp_{st}"]) if have else 0.0
                f[f"opp_sim_{st}_mult"] = (a + prior_mass) / (e + prior_mass) if e + prior_mass > 0 else 1.0
            res[idx] = f
    return pd.DataFrame.from_dict(res, orient="index")


def _last_carries_share(hist: pd.DataFrame, t: pd.DataFrame) -> pd.DataFrame:
    """last_carries_share: the player's share of his team's carries in the team's previous game, when he played in it
    (the game simulation blends it into the window share; see gamesim.PARAMS["last_car_w"])."""
    tg = hist.groupby(["season", "week", "team"]).carries.sum().rename("team_car").reset_index()
    pc = hist.groupby(["season", "week", "team", "player_id"]).carries.sum().rename("car").reset_index()
    order = tg.sort_values(["season", "week"])
    by_team = {tm: list(zip(g.season, g.week, g.team_car)) for tm, g in order.groupby("team")}
    car = {(r.season, r.week, r.team, r.player_id): r.car for r in pc.itertuples(index=False)}
    out = {}
    for idx, r in zip(t.index, t[["season", "week", "team", "player_id"]].itertuples(index=False)):
        games = [x for x in by_team.get(r.team, []) if (x[0], x[1]) < (r.season, r.week)]
        if not games:
            continue
        s_, w_, tot = games[-1]
        n = car.get((s_, w_, r.team, r.player_id))
        if n is not None and tot > 0:
            out[idx] = {"last_carries_share": n / tot}
    return pd.DataFrame.from_dict(out, orient="index", columns=["last_carries_share"]) if out else \
        pd.DataFrame(index=t.index[:0], columns=["last_carries_share"])


def population(t: pd.DataFrame, market: str) -> pd.Series:
    m = MARKETS[market]
    col, thr = VOLUME_RULES[m["volume"]]
    ok = t.position.isin(m["positions"]) & t.has_history.eq(1) & (t.get(col, pd.Series(0, index=t.index)).fillna(0) >= thr)
    ok &= t.changed_team.fillna(0).eq(0)
    if m["volume"] == "attempts":
        ok &= t.attempts_last.fillna(0) >= 15  # started his most recent game
    return ok


def feature_list(market: str) -> tuple[list[str], list[str]]:
    """(full feature list for the GBM, compact list for the GLM)."""
    st = MARKETS[market]["stat"]
    ctx = ["team_implied_total", "opp_implied_total", "total_line", "spread_for", "is_home"]
    base = [f"{st}_pg", f"{st}_med", f"{st}_l3", f"{st}_cur", "n_games_cur", "eff_games", "snap_pct", f"opp_{st}_mult"]
    vol = {"attempts": ["attempts_pg", "team_attempts_pg", "ypa", "comp_pct", "opp_attempts_mult"],
           "carries": ["carries_pg", "carries_share", "team_carries_pg", "ypc", "opp_carries_mult"],
           "targets": ["targets_pg", "targets_share", "team_targets_pg", "ypt", "catch_rate", "opp_targets_mult"],
           "touches": ["carries_pg", "targets_pg", "carries_share", "targets_share", "ypc", "ypt", "opp_rush_yards_mult",
                       "opp_rec_yards_mult"]}[MARKETS[market]["volume"]]
    sim = [f"opp_sim_{x}_mult" for x in SIMILAR_STATS.get(market, ())]
    glm = list(dict.fromkeys(base[:4] + vol[:3] + ctx[:2] + [f"opp_{st}_mult"]))
    full = list(dict.fromkeys(base + vol + ctx + ["targets_pg", "carries_pg", "receptions_pg", "rec_yards_pg", "rush_yards_pg",
                                                  "attempts_pg", "pass_yards_pg", "targets_share", "carries_share"] + sim))
    return full, glm


# --------------------------------------------------------------------------- models
class MeanModel:
    def __init__(self, name: str, market: str):
        self.name, self.market = name, market
        self.full, self.glm = feature_list(market)
        self.stat = MARKETS[market]["stat"]

    def fit(self, train: pd.DataFrame):
        y = train[self.stat].clip(lower=0).to_numpy(float)
        if self.name == "props-gbm-1":
            self.cols = self.full
            self.m = HistGradientBoostingRegressor(loss="poisson", learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
                                                   min_samples_leaf=40, l2_regularization=1.0, random_state=7)
        elif self.name == "props-glm-1":
            self.cols = self.glm
            self.m = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), PoissonRegressor(alpha=1e-3, max_iter=500))
        elif self.name == "baseline-position-avg":
            self.pos_mean = train.groupby("position")[self.stat].mean().to_dict()
            self.overall = float(train[self.stat].mean())
            return self
        else:  # baseline-player-avg: player's weighted recent average, shrunk toward the position average
            self.pos_mean = train.groupby("position")[self.stat].mean().to_dict()
            return self
        from .models import recency_weights  # noqa: PLC0415
        w = recency_weights(train, RECENCY_HALF_LIFE or 0)
        key = "poissonregressor__sample_weight" if self.name == "props-glm-1" else "sample_weight"
        self.m.fit(train[self.cols].astype(float), y, **({key: w} if w is not None else {}))
        return self

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        if self.name == "baseline-position-avg":
            return df.position.map(self.pos_mean).fillna(self.overall).to_numpy(float)
        if self.name == "baseline-player-avg":
            pm = df.position.map(self.pos_mean).to_numpy(float)
            eff = df.eff_games.fillna(0).to_numpy(float)
            avg = df[f"{self.stat}_pg"].fillna(0).to_numpy(float)
            return (avg * eff + pm * PLAYER_SHRINK_GAMES) / (eff + PLAYER_SHRINK_GAMES)
        return np.clip(self.m.predict(df[self.cols].astype(float)), 0.05, None)


class Distribution:
    """Turns a mean into a predictive distribution, fit on a later holdout slice of the training data."""

    def __init__(self, kind: str):
        self.kind = kind
        self.platt = (1.0, 0.0)  # over/under recalibration: sigmoid(a * logit(p) + b)

    def fit_overunder(self, mu: np.ndarray, line: np.ndarray, y: np.ndarray):
        """Recalibrate P(over) on the holdout slice. Raw distributions are overconfident when the projection
        moves far from the player's usual output, so the slope is usually below 1 (pulls toward 50%)."""
        from sklearn.linear_model import LogisticRegression

        z = _logit(self._raw_over(mu, line))
        over = (y > line).astype(int)
        if len(set(over)) == 2 and len(over) >= 100:
            lr = LogisticRegression(C=1e4).fit(z[:, None], over)
            self.platt = (float(np.clip(lr.coef_[0][0], 0.2, 1.5)), float(lr.intercept_[0]))
        return self

    def fit(self, mu: np.ndarray, y: np.ndarray):
        mu = np.clip(mu, 0.05, None)
        if self.kind == "count":
            # NB2 dispersion (Var = mu + alpha * mu^2) by maximum likelihood on held-out rows.
            from scipy.optimize import minimize_scalar

            yy = np.clip(np.round(y), 0, None)

            def nll(log_a):
                n = 1.0 / np.exp(log_a)
                return -sps.nbinom.logpmf(yy, n, n / (n + mu)).sum()

            self.alpha = float(np.exp(minimize_scalar(nll, bounds=(np.log(1e-4), np.log(5.0)), method="bounded").x))
        else:
            r = y / mu
            self.edges = np.quantile(mu, [1 / 3, 2 / 3])
            self.ratio_q = [np.quantile(r[self._bucket(mu) == b], QUANTS) if (self._bucket(mu) == b).sum() >= 50
                            else np.quantile(r, QUANTS) for b in range(3)]
            # The ratios themselves, so the model can say how much mass it puts on a range. Zero-yard games are a point
            # mass: a range starting at 0 then holds more than its nominal share.
            self.ratios = [np.sort(r[self._bucket(mu) == b]) if (self._bucket(mu) == b).sum() >= 50 else np.sort(r) for b in range(3)]
        return self

    def _bucket(self, mu):
        return np.digitize(mu, self.edges)

    def quantiles(self, mu: np.ndarray) -> np.ndarray:
        mu = np.clip(np.asarray(mu, float), 0.05, None)
        if self.kind == "count":
            n = 1.0 / self.alpha
            p = n / (n + mu)
            return sps.nbinom.ppf(QUANTS[None, :], n, p[:, None])
        b = self._bucket(mu)
        rq = np.stack([self.ratio_q[i] for i in b])
        return mu[:, None] * rq

    def p_over(self, mu: np.ndarray, line: np.ndarray) -> np.ndarray:
        a, b = self.platt
        return np.clip(1 / (1 + np.exp(-(a * _logit(self._raw_over(mu, line)) + b))), 0.005, 0.995)

    def _raw_over(self, mu: np.ndarray, line: np.ndarray) -> np.ndarray:
        mu = np.clip(np.asarray(mu, float), 0.05, None)
        line = np.asarray(line, float)
        if self.kind == "count":
            n = 1.0 / self.alpha
            return sps.nbinom.sf(np.floor(line), n, n / (n + mu))
        return p_over_from_quantiles(self.quantiles(mu), line)

    def mass_between(self, mu: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
        """Probability the model itself puts on [lo, hi]: above 0.8 for counts, whose quantiles are whole numbers, and for
        yardage when the range starts at a point mass of zero-yard games."""
        if self.kind != "count":
            mu = np.clip(np.asarray(mu, float), 0.05, None)
            out = np.empty(len(mu))
            for i, (m, b, a, z) in enumerate(zip(mu, self._bucket(mu), np.asarray(lo, float), np.asarray(hi, float))):
                r = self.ratios[b]
                out[i] = (np.searchsorted(r, z / m, side="right") - np.searchsorted(r, a / m, side="left")) / len(r)
            return out
        n = 1.0 / self.alpha
        p = n / (n + np.clip(np.asarray(mu, float), 0.05, None))
        return sps.nbinom.cdf(hi, n, p) - sps.nbinom.cdf(lo - 1, n, p)

    def describe(self, mu: float) -> dict:
        """Compact representation the client can use to price any line."""
        if self.kind == "count":
            n = 1.0 / self.alpha
            p = n / (n + max(mu, 0.05))
            top = int(sps.nbinom.ppf(0.999, n, p)) + 1
            return {"type": "nbinom", "n": n, "p": p, "platt": list(self.platt),
                    "cdf": [round(float(x), 5) for x in sps.nbinom.cdf(np.arange(top + 1), n, p)]}
        q = self.quantiles(np.array([mu]))[0]
        return {"type": "quantiles", "platt": list(self.platt), "q": [round(float(x), 2) for x in q]}


def _logit(p):
    p = np.clip(np.asarray(p, float), 0.005, 0.995)
    return np.log(p / (1 - p))


def p_over_from_quantiles(q: np.ndarray, line: np.ndarray) -> np.ndarray:
    """P(Y > line) by linear interpolation of the CDF through the 1..99% quantiles (clamped to 0.5%..99.5%)."""
    out = np.empty(len(line))
    for i, (qi, li) in enumerate(zip(q, line)):
        if li < qi[0]:
            out[i] = 0.995
        elif li >= qi[-1]:
            out[i] = 0.005
        else:
            # np.interp needs increasing x; repeated quantiles (point masses at 0) are handled by taking the last.
            j = np.searchsorted(qi, li, side="right")
            lo, hi = qi[j - 1], qi[j]
            f = QUANTS[j - 1] + (QUANTS[j] - QUANTS[j - 1]) * ((li - lo) / (hi - lo) if hi > lo else 1.0)
            out[i] = 1 - f
    return np.clip(out, 0.005, 0.995)


def crps_from_quantiles(q: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Sample CRPS treating the 99 quantiles as an equally weighted ensemble."""
    a = np.abs(q - y[:, None]).mean(axis=1)
    s = np.sort(q, axis=1)
    k = s.shape[1]
    w = 2 * np.arange(1, k + 1) - k - 1
    b = (s * w).sum(axis=1) / (k * k)  # = 0.5 * mean |X - X'|
    return a - b


def fit_market_model(name: str, market: str, train: pd.DataFrame):
    """Fit mean on the earlier 75% (by date), fit the distribution on the later 25%, then refit the mean on everything."""
    kind = MARKETS[market]["kind"]
    stat = MARKETS[market]["stat"]
    order = train.season * 100 + train.week
    cut = np.quantile(order, 0.75)
    early, late = train[order <= cut], train[order > cut]
    if len(late) < 100 or len(early) < 200:
        early, late = train, train
    m = MeanModel(name, market).fit(early)
    mu_late, y_late = m.predict(late), late[stat].to_numpy(float)
    dist = Distribution(kind).fit(mu_late, y_late).fit_overunder(mu_late, reference_line(late, market), y_late)
    return MeanModel(name, market).fit(train), dist


def reference_line(df: pd.DataFrame, market: str) -> np.ndarray:
    """Book-like reference line from the player's own recent median (floor + 0.5). Used only for backtesting."""
    st = MARKETS[market]["stat"]
    return np.floor(df[f"{st}_med"].fillna(df[f"{st}_pg"]).fillna(0).to_numpy(float)) + 0.5


# --------------------------------------------------------------------------- walk-forward
def walk_forward(c: sqlite3.Connection, frame: pd.DataFrame, test_weeks: list[tuple[int, int]], markets=None, log=print) -> dict:
    run_id = "pwf-" + uuid.uuid4().hex[:10]
    lab = frame[frame.labelled == 1]
    report = {"run_id": run_id, "created_at": utcnow(), "markets": {}, "gate_rules": GATE}
    rows = []
    for market in markets or MARKETS:
        st = MARKETS[market]["stat"]
        pop = lab[population(lab, market)]
        P = []
        for s, w in test_weeks:
            train = pop[(pop.season < s) | ((pop.season == s) & (pop.week < w))]
            test = pop[(pop.season == s) & (pop.week == w)]
            if len(train) < 400 or test.empty:
                continue
            out = test[["season", "week", "player_id", "player_name", "team", "position", st]].copy()
            line = reference_line(test, market)
            out["line"] = line
            for name in CANDIDATES + BASELINES:
                m, dist = fit_market_model(name, market, train)
                mu = m.predict(test)
                q = dist.quantiles(mu)
                out[f"mu::{name}"] = mu
                out[f"med::{name}"] = q[:, 49]
                out[f"q10::{name}"] = q[:, 9]
                out[f"q90::{name}"] = q[:, 89]
                out[f"crps::{name}"] = crps_from_quantiles(q, test[st].to_numpy(float))
                out[f"covexp::{name}"] = dist.mass_between(mu, q[:, 9], q[:, 89])
                out[f"pover::{name}"] = dist.p_over(mu, line)
            P.append(out)
        if not P:
            log(f"props {market}: no test weeks")
            continue
        P = pd.concat(P, ignore_index=True)
        rep = evaluate_market(P, market)
        report["markets"][market] = rep
        log(f"props {market}: n={rep['n']:,} promoted={rep['gate']['promoted']} " +
            " ".join(f"{k}={v['crps']:.3f}" for k, v in rep["models"].items()))
        P["market"] = market
        rows.append(P)
    _store(c, run_id, report, pd.concat(rows, ignore_index=True) if rows else pd.DataFrame())
    return report


def _bootstrap_gain(P: pd.DataFrame, a: str, b: str, reps: int) -> tuple[float, float]:
    """95% CI of mean CRPS(b) - CRPS(a) resampling whole weeks (positive = a is better)."""
    wk = P.groupby(["season", "week"])
    d = wk.apply(lambda g: pd.Series({"gain": (g[f"crps::{b}"] - g[f"crps::{a}"]).sum(), "n": len(g)}), include_groups=False)
    rng = np.random.default_rng(11)
    g, n = d.gain.to_numpy(), d.n.to_numpy()
    sims = []
    for _ in range(reps):
        i = rng.integers(0, len(g), len(g))
        sims.append(g[i].sum() / n[i].sum())
    return float(np.quantile(sims, 0.025)), float(np.quantile(sims, 0.975))


def _ece_noise95(p, reps=300, bins=10):
    """95th percentile of ECE when outcomes really are Bernoulli(p): the noise floor for this sample size."""
    rng = np.random.default_rng(5)
    return float(np.quantile([_ece((rng.random(len(p)) < p).astype(int), p, bins)[0] for _ in range(reps)], 0.95))


def _ece(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    e, cal = 0.0, []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & ((p < hi) if hi < 1 else (p <= hi))
        if m.sum():
            e += m.sum() * abs(p[m].mean() - y[m].mean())
            cal.append({"lo": round(float(lo), 2), "hi": round(float(hi), 2), "n": int(m.sum()), "mean_pred": float(p[m].mean()),
                        "observed": float(y[m].mean())})
    return e / len(y), cal


def evaluate_market(P: pd.DataFrame, market: str) -> dict:
    st = MARKETS[market]["stat"]
    y = P[st].to_numpy(float)
    over = (y > P.line.to_numpy(float)).astype(int)
    latest = P.season.max()
    models_ = {}
    for name in CANDIDATES + BASELINES:
        p = P[f"pover::{name}"].to_numpy(float)
        ece, cal = _ece(over, p)
        lean = np.abs(p - 0.5) >= 0.1
        models_[name] = {
            "crps": float(P[f"crps::{name}"].mean()),
            "crps_latest_season": float(P.loc[P.season == latest, f"crps::{name}"].mean()),
            "mae_median": float(np.mean(np.abs(P[f"med::{name}"] - y))),
            "mean_error": float(np.mean(P[f"mu::{name}"] - y)),
            "coverage_10_90": float(np.mean((y >= P[f"q10::{name}"]) & (y <= P[f"q90::{name}"]))),
            "coverage_expected": float(P[f"covexp::{name}"].mean()),
            "over_brier": float(np.mean((p - over) ** 2)),
            "over_ece": float(ece), "over_ece_noise95": _ece_noise95(p) if name in CANDIDATES else None,
            "over_calibration": cal,
            "lean_n": int(lean.sum()),
            "lean_hit_rate": float(np.mean((p[lean] > 0.5) == (over[lean] == 1))) if lean.any() else None,
        }
    weeks = P[["season", "week"]].drop_duplicates()
    best_base = min(BASELINES, key=lambda n: models_[n]["crps"])
    checks, passing = {}, []
    for name in CANDIDATES:
        m = models_[name]
        lo, hi = _bootstrap_gain(P, name, best_base, GATE["bootstrap_reps"])
        ck = {
            "enough_rows": len(P) >= GATE["min_test_rows"],
            "enough_weeks": len(weeks) >= GATE["min_test_weeks"],
            "beats_baselines_crps": all(m["crps"] < models_[b]["crps"] for b in BASELINES),
            "crps_gain_ci_excludes_zero": lo > 0,
            "beats_baselines_over_brier": all(m["over_brier"] <= models_[b]["over_brier"] for b in BASELINES),
            "over_calibrated": m["over_ece"] <= max(GATE["max_ece"], m["over_ece_noise95"]),
            "range_calibrated": abs(m["coverage_10_90"] - m["coverage_expected"]) <= GATE["coverage_tolerance"],
            "latest_season_not_worse": m["crps_latest_season"] <= models_["baseline-player-avg"]["crps_latest_season"],
        }
        checks[name] = {"checks": ck, "crps_gain_ci": [lo, hi], "pass": all(ck.values())}
        if all(ck.values()):
            passing.append(name)
    promoted = None
    if passing:
        best = min(passing, key=lambda n: models_[n]["crps"])
        # Parsimony: the GLM wins when it is within tolerance of the best passing model.
        promoted = "props-glm-1" if "props-glm-1" in passing and \
            models_["props-glm-1"]["crps"] <= models_[best]["crps"] * (1 + GATE["parsimony_tolerance"]) else best
    research = promoted or min(CANDIDATES, key=lambda n: models_[n]["crps"])
    return {"market": market, "label": MARKETS[market]["label"], "n": int(len(P)), "weeks": int(len(weeks)),
            "over_rate_at_reference": float(over.mean()), "models": models_,
            "gate": {"promoted": promoted, "research_model": research, "best_baseline": best_base, "candidates": checks}}


def _store(c, run_id, report, P):
    with c:
        c.execute("INSERT INTO prop_runs VALUES (?,?,?,?,?)", (run_id, "walk_forward", report["created_at"], json.dumps(report), None))
        keep = []
        for market, g in (P.groupby("market") if len(P) else []):
            st = MARKETS[market]["stat"]
            for name in CANDIDATES + BASELINES:
                cols = ["season", "week", "player_id", "player_name", "team", "position", f"mu::{name}", f"med::{name}", "line",
                        f"pover::{name}", st]
                keep += [(run_id, market, name, *row) for row in g[cols].itertuples(index=False, name=None)]
        c.executemany("INSERT OR REPLACE INTO prop_backtest VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", keep)


# --------------------------------------------------------------------------- weekly projections
def latest_report(c) -> dict | None:
    r = c.execute("SELECT report FROM prop_runs WHERE kind='walk_forward' ORDER BY created_at DESC LIMIT 1").fetchone()
    return json.loads(r["report"]) if r else None


def project_week(c: sqlite3.Connection, frame: pd.DataFrame, season: int, week: int, log=print) -> dict:
    rep = latest_report(c)
    if rep is None:
        raise RuntimeError("Run the props walk-forward before projecting a week.")
    run_id = "prp-" + uuid.uuid4().hex[:10]
    rows = frame[(frame.season == season) & (frame.week == week)]
    lab = frame[(frame.labelled == 1) & ((frame.season < season) | ((frame.season == season) & (frame.week < week)))]
    out, summary = [], {}
    for market, mrep in rep["markets"].items():
        gate = mrep["gate"]
        name = gate["promoted"] or gate["research_model"]
        calibrated = gate["promoted"] is not None
        pop = population(rows, market)
        cand = rows[pop]
        if cand.empty:
            continue
        train = lab[population(lab, market)]
        m, dist = fit_market_model(name, market, train)
        mu = m.predict(cand)
        q = dist.quantiles(mu)
        st = MARKETS[market]["stat"]
        for i, (idx, r) in enumerate(cand.iterrows()):
            status = r.get("status")
            rep_status = r.get("report_status")
            exclusion = None
            if r.get("labelled", 0) == 0 and isinstance(status, str) and status != "ACT":
                exclusion = f"Roster status {status}"
            elif isinstance(rep_status, str) and rep_status in PASS_ON:
                exclusion = f"Injury report: {rep_status}"
            flags = []
            if isinstance(rep_status, str) and rep_status == "Questionable":
                flags.append("Questionable on the injury report")
            if r.get("labelled", 0) == 0 and not r.get("injury_report_published", 1):
                flags.append("Injury report not yet published for this game")
            if (r.get("n_games_cur") or 0) < 3:
                flags.append("Fewer than 3 games this season")
            actual = float(r[st]) if r.get("labelled", 0) == 1 else None
            out.append((run_id, market, season, week, r.player_id, r.player_name, r.team, r.opponent, r.position, r.game_id,
                        int(exclusion is None), exclusion, json.dumps(flags), name, int(calibrated), float(mu[i]), float(q[i, 49]),
                        float(q[i, 9]), float(q[i, 89]), json.dumps(dist.describe(float(mu[i]))),
                        json.dumps(_explain(r, market)), actual))
        summary[market] = {"model": name, "calibrated": calibrated, "players": int(len(cand))}
    with c:
        c.execute("INSERT INTO prop_runs VALUES (?,?,?,?,?)", (run_id, "projection", utcnow(),
                                                              json.dumps({"season": season, "week": week, "walk_forward_run": rep["run_id"],
                                                                          "markets": summary}), rep["run_id"]))
        c.executemany("INSERT OR REPLACE INTO prop_projections VALUES (" + ",".join("?" * 22) + ")", out)
    log(f"props projections {season} W{week}: " + ", ".join(f"{k} {v['players']}" for k, v in summary.items()))
    return {"run_id": run_id, "season": season, "week": week, "markets": summary}


def _explain(r, market) -> dict:
    """The evidence a reader needs, all from games before the target week."""
    st = MARKETS[market]["stat"]

    def g(k):
        v = r.get(k)
        return None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), 3)

    vol = MARKETS[market]["volume"]
    keys = [f"{st}_pg", f"{st}_med", f"{st}_l3", f"{st}_cur", f"opp_{st}_mult", "team_implied_total", "opp_implied_total",
            "n_games_cur", "snap_pct"]
    keys += {"attempts": ["attempts_pg", "team_attempts_pg", "ypa", "comp_pct"], "carries": ["carries_pg", "carries_share", "ypc"],
             "targets": ["targets_pg", "targets_share", "ypt", "catch_rate"],
             "touches": ["carries_pg", "targets_pg", "ypc", "ypt"]}[vol]
    return {k: g(k) for k in dict.fromkeys(keys)}


def upcoming_rows(feats: pd.DataFrame, season: int, week: int) -> pd.DataFrame:
    """Roster rows for a week whose games are not played yet (from the TD feature cache: status, injuries)."""
    u = feats[(feats.season == season) & (feats.week == week) & (feats.game_completed == 0)]
    cols = ["season", "week", "game_id", "player_id", "player_name", "position", "team", "opponent", "status", "report_status",
            "injury_report_published"]
    return u[[c_ for c_ in cols if c_ in u.columns]].drop_duplicates(["player_id", "team"])
