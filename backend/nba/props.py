"""NBA player props: projections, full distributions and a walk-forward check against baselines.

Markets: points, rebounds, assists, threes, points+rebounds+assists. For each market a gradient-boosted Poisson
regression predicts the player's mean from pregame features (minutes, per-minute rates, shot volume, pace, opponent
allowances by position, rest, home). The spread around that mean is a negative binomial whose dispersion, and a small
over/under calibration, are learned only from earlier out-of-sample predictions.

Walk-forward: the model is refit at the start of every month on all earlier games and predicts that month's games.
Training games are weighted by age (half-life RECENCY_HALF_LIFE seasons), so the last two seasons count most.
No historical sportsbook lines are freely available, so the reference line is the player's usual line: the median of
his last 10 games rounded down plus 0.5.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats as st
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression

from . import history

MARKETS = {
    "points": "Points", "rebounds": "Rebounds", "assists": "Assists", "threes": "Threes made", "pra": "Pts + Reb + Ast",
}
RECENCY_HALF_LIFE = 2.0       # seasons
FIRST_TEST_SEASON = 2022      # 2021-22 onward is tested game by game; earlier seasons only train
MIN_PRIOR_GAMES = 5
CAP = 120


def usual_line(p: pd.DataFrame, market: str) -> pd.Series:
    med = p.groupby("player_id")[market].transform(lambda s: s.shift(1).rolling(10, min_periods=5).median())
    return np.floor(med) + 0.5


def nb_params(mu: np.ndarray, alpha) -> tuple[np.ndarray, np.ndarray]:
    """scipy nbinom (n, p) for mean mu and variance mu + alpha mu^2 (alpha: one value or one per row)."""
    mu = np.asarray(mu, float)
    n = 1.0 / np.maximum(np.broadcast_to(np.asarray(alpha, float), mu.shape), 1e-4)
    return n, n / (n + mu)


# Players on short minutes swing far more than their average suggests (minutes themselves move), so the spread is
# learned separately for each band of recent minutes.
MINUTE_BINS = [0, 12, 18, 24, 30, 99]


def minute_band(min_l) -> np.ndarray:
    return np.clip(np.digitize(np.asarray(min_l, float), MINUTE_BINS[1:-1]), 0, len(MINUTE_BINS) - 2)


def fit_alpha_bands(y: np.ndarray, mu: np.ndarray, min_l: np.ndarray, min_rows: int = 300) -> list[float]:
    band = minute_band(min_l)
    overall = fit_alpha(y, mu)
    return [fit_alpha(y[band == b], mu[band == b]) if (band == b).sum() >= min_rows else overall
            for b in range(len(MINUTE_BINS) - 1)]


def alpha_for(min_l, bands: list[float]) -> np.ndarray:
    return np.asarray(bands, float)[minute_band(min_l)]


def fit_alpha(y: np.ndarray, mu: np.ndarray, max_rows: int = 30000) -> float:
    """Maximum-likelihood negative binomial dispersion (a fixed subsample keeps it fast)."""
    from scipy.optimize import minimize_scalar  # noqa: PLC0415
    if len(y) > max_rows:
        i = np.random.default_rng(0).choice(len(y), max_rows, replace=False)
        y, mu = y[i], mu[i]

    def nll(la):
        n, pr = nb_params(mu, float(np.exp(la)))
        return -st.nbinom.logpmf(y, n, pr).sum()
    r = minimize_scalar(nll, bounds=(np.log(1e-4), np.log(3.0)), method="bounded", options={"xatol": 1e-3})
    return float(np.exp(r.x))


def p_over_raw(mu: np.ndarray, alpha: float, line: np.ndarray) -> np.ndarray:
    n, pr = nb_params(mu, alpha)
    return np.clip(st.nbinom.sf(np.floor(line), n, pr), 0.005, 0.995)


def crps(mu: np.ndarray, alpha: float, y: np.ndarray) -> np.ndarray:
    """Ranked probability score over 0..CAP for a negative binomial forecast."""
    k = np.arange(CAP + 1)
    n, pr = nb_params(mu, alpha)
    cdf = st.nbinom.cdf(k[None, :], n[:, None], pr[:, None])
    obs = (k[None, :] >= y[:, None]).astype(float)
    return ((cdf - obs) ** 2).sum(axis=1)


def _logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def recency_weight(season: pd.Series, test_season: int) -> np.ndarray:
    return 0.5 ** ((test_season - season.to_numpy()) / RECENCY_HALF_LIFE)


def model_rows(p: pd.DataFrame, market: str) -> pd.DataFrame:
    cols = history.features_for(market)
    r = p[(p.games_prior >= MIN_PRIOR_GAMES)].copy()
    r["line"] = usual_line(p, market).loc[r.index]
    r["y"] = r[market]
    r["base_mu"] = (r[f"{market}_pm_l"] * r["min_l"]).clip(lower=0.05)   # player average baseline (per-minute x minutes)
    return r.dropna(subset=["min_l"])[["game_id", "game_date", "season", "player_id", "player_name", "team", "opp", "pos",
                                       "played", "y", "line", "base_mu", "season_starts"] + cols]


def _fit(train: pd.DataFrame, cols: list[str], test_season: int) -> HistGradientBoostingRegressor:
    m = HistGradientBoostingRegressor(loss="poisson", max_iter=250, learning_rate=0.06, max_leaf_nodes=31,
                                      min_samples_leaf=200, l2_regularization=1.0, random_state=0)
    m.fit(train[cols], train.y, sample_weight=recency_weight(train.season, test_season))
    return m


def walk_forward(p: pd.DataFrame, market: str, first_test: int = FIRST_TEST_SEASON, cached: pd.DataFrame | None = None,
                 log=print) -> pd.DataFrame:
    """Out-of-sample predictions for every played game from first_test on, refit monthly. Finished months already in
    `cached` are reused (their games and models cannot change); the latest month is always redone."""
    r = model_rows(p, market)
    r = r[r.played]
    cols = history.features_for(market)
    r["month"] = r.game_date.dt.to_period("M")
    months = sorted(r[r.season >= first_test].month.unique())
    keep = set()
    if cached is not None and len(cached):
        keep = set(cached.month.unique()) - {months[-1]} if months else set()
    out = [cached[cached.month.isin(keep)].drop(columns=[c for c in cached.columns if c not in r.columns and c != "mu"])] if keep else []
    for month in months:
        if month in keep:
            continue
        test = r[r.month == month]
        train = r[r.game_date < test.game_date.min()]
        m = _fit(train, cols, int(test.season.max()))
        t = test.copy()
        t["mu"] = np.clip(m.predict(t[cols]), 0.05, None)
        out.append(t)
    res = pd.concat(out)
    log(f"nba props {market}: {len(res):,} test games, {res.month.nunique()} months ({len(months) - len(keep)} refit)")
    return calibrate_oos(res)


def calibrate_oos(res: pd.DataFrame) -> pd.DataFrame:
    """Spread (by minutes band) and over/under calibration for each month, learned only from earlier months'
    out-of-sample rows."""
    res = res.sort_values("game_date").copy()
    for c in ("alpha", "base_alpha", "p_over_raw", "p_over", "p_over_base"):
        res[c] = np.nan
    months = sorted(res.month.unique())
    for i, mth in enumerate(months):
        cur = (res.month == mth).to_numpy()
        prev = res[res.month.isin(months[max(0, i - 12):i])]
        if len(prev) < 2000:
            continue
        bands = fit_alpha_bands(prev.y.to_numpy(), prev.mu.to_numpy(), prev.min_l.to_numpy())
        bbands = fit_alpha_bands(prev.y.to_numpy(), prev.base_mu.to_numpy(), prev.min_l.to_numpy())
        c = res.loc[cur]
        res.loc[cur, "alpha"] = alpha_for(c.min_l, bands)
        res.loc[cur, "base_alpha"] = alpha_for(c.min_l, bbands)
        platt = fit_platt(prev, bands)
        raw = p_over_raw(c.mu.to_numpy(), alpha_for(c.min_l, bands), c.line.fillna(0).to_numpy())
        res.loc[cur, "p_over_raw"] = raw
        res.loc[cur, "p_over"] = apply_platt(raw, platt)
        res.loc[cur, "p_over_base"] = p_over_raw(c.base_mu.to_numpy(), alpha_for(c.min_l, bbands), c.line.fillna(0).to_numpy())
    return res.dropna(subset=["alpha"])


def fit_platt(prev: pd.DataFrame, bands: list[float]) -> list[float]:
    h = prev[prev.line.notna()]
    raw = p_over_raw(h.mu.to_numpy(), alpha_for(h.min_l, bands), h.line.to_numpy())
    lr = LogisticRegression(C=100.0).fit(_logit(raw)[:, None], (h.y > h.line).astype(int))
    return [float(lr.coef_[0][0]), float(lr.intercept_[0])]


def apply_platt(raw: np.ndarray, platt: list[float]) -> np.ndarray:
    """Same rule as frontend pOver: clamp, logistic recalibration, clamp."""
    return np.clip(1 / (1 + np.exp(-(platt[0] * _logit(np.clip(raw, 0.005, 0.995)) + platt[1]))), 0.005, 0.995)
