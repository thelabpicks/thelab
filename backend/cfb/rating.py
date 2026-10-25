"""The Lab rating: every lean scored out of 10, from the simulations and what similar leans did in the past.

1. The 5,000-game simulation gives the model's chance for the side it likes.
2. That chance is calibrated on past results: an isotonic fit, per market (moneyline underdogs and favorites apart), of how much of the simulation's edge over
   the market's own chance leans really kept (recent seasons count most). A simulation that says 58% on a -110 total,
   when leans like it won 53%, becomes 53%; an underdog the market gives 30% and the simulation 40% becomes whatever
   dogs like it really won.
3. The calibrated chance is priced at the best odds on offer: expected return per $1 (-110 when no price is known).
4. The rating is where that expected return ranks among every lean in the backtest, out of 10: 9 means better than
   90% of past leans.

The rating is tested the same way the model is: each season is rated with calibrations fit on earlier seasons only,
and the record of each rating band is published (bands()).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from . import history, report

DEC110 = 210 / 110
HALF_LIFE = 2.0        # seasons
BANDS = [(0, 5), (5, 7), (7, 8), (8, 9), (9, 10.01)]


def cal_key(market: str, dec: float | None) -> str:
    """Moneyline underdogs and favorites are calibrated apart: the simulation's edge held up differently on each
    (walk-forward 2018-2025, see CFB.md), and one shared fit rated short favorites too high."""
    if market != "moneyline":
        return market
    return "moneyline_dog" if (dec or DEC110) > 2 else "moneyline_fav"


def legs_from_backtest(bt: pd.DataFrame) -> pd.DataFrame:
    """Every graded lean of the game-line backtest: chance, market's chance (q), decimal price, won, season."""
    g = report.graded(bt)
    legs = [g[k][["p", "won", "season"]].assign(market=k, dec=DEC110, q=0.5) for k in ("spread", "total", "team_total")]
    ml = report.moneyline_bets(bt)
    if len(ml):
        m = bt.loc[ml.index]
        ih, ia = history.implied(m.ml_home.to_numpy()), history.implied(m.ml_away.to_numpy())
        home = ml.price.to_numpy() == m.ml_home.to_numpy()
        q = np.where(home, ih / (ih + ia), ia / (ih + ia))
        legs.append(ml[["p", "won", "season"]].assign(market="moneyline", dec=history.decimal(ml.price.to_numpy()), q=q))
    L = pd.concat(legs, ignore_index=True)
    L["ret"] = L.won * L.dec - 1
    L["cal"] = [cal_key(m, d) for m, d in zip(L.market, L.dec)]
    return L


def _iso(t: pd.DataFrame, w: np.ndarray) -> IsotonicRegression:
    """How much of the simulation's edge over the market (its chance minus the market's) leans really kept."""
    return IsotonicRegression(out_of_bounds="clip").fit((t.p - t.q).to_numpy(), (t.won - t.q).to_numpy(), sample_weight=w)


def fit(L: pd.DataFrame) -> dict:
    """Calibrations per market and the reference spread of expected returns, from every lean in L."""
    if "cal" not in L:
        L = L.assign(cal=L.market)
    last = L.season.max()
    w = 0.5 ** ((last - L.season) / HALF_LIFE)
    cal, ref = {}, []
    for m, t in L.groupby("cal"):
        iso = _iso(t, w[t.index].to_numpy())
        cal[m] = [iso.X_thresholds_.round(4).tolist(), iso.y_thresholds_.round(4).tolist()]
        ref.append((t.q.to_numpy() + iso.predict((t.p - t.q).to_numpy())) * t.dec.to_numpy() - 1)
    ref = np.concatenate(ref)
    return {"cal": cal, "ref": np.quantile(ref, np.linspace(0, 1, 401)).round(5).tolist()}


def calibrated(r: dict, market: str, p: float, q: float = 0.5) -> float:
    """The calibrated chance never claims more edge over the market than the simulation does, and an edge smaller
    than any the fit has seen keeps the market's chance. The isotonic ends rest on a handful of leans: without the
    bound a 31% underdog the market gave 30% came out at 1.5% (rating 0.0), and the largest edges were stretched
    (walk-forward 7+ return +1.6% -> +2.0% with the bound)."""
    xs, ys = r["cal"].get(market, r["cal"].get(market.split("_")[0], [[-1, 1], [-1, 1]]))
    x = p - q
    edge = min(x, 0.0) if x < xs[0] else float(np.interp(x, xs, ys))
    return float(np.clip(q + min(edge, max(x, 0.0)), 0, 1))


def rate(r: dict, market: str, p: float, dec: float | None, q: float = 0.5) -> dict:
    """Calibrated chance, expected return per $1 at `dec` (decimal odds) and the rating out of 10. `q` is the market's
    own chance for the side (vig removed; 0.5 for spreads and totals)."""
    dec = dec or DEC110
    pc = calibrated(r, cal_key(market, dec), p, q)
    ev = pc * dec - 1
    rating = 10 * float(np.searchsorted(r["ref"], ev, side="right")) / len(r["ref"])
    return {"fair_p": round(pc, 4), "ev": round(ev, 4), "rating": round(min(rating, 10.0), 1)}


def walk_forward(L: pd.DataFrame, min_seasons: int = 2) -> pd.DataFrame:
    """Every season rated with calibrations and references fit on earlier seasons only."""
    if "cal" not in L:
        L = L.assign(cal=L.market)
    out = []
    for s in sorted(L.season.unique()):
        tr = L[L.season < s]
        if tr.season.nunique() < min_seasons:
            continue
        r = fit(tr)
        te = L[L.season == s].copy()
        pc = np.array([calibrated(r, m, p, q) for m, p, q in zip(te.cal, te.p, te.q)])
        te["ev"] = pc * te.dec - 1
        te["rating"] = 10 * np.searchsorted(r["ref"], te.ev, side="right") / len(r["ref"])
        out.append(te)
    return pd.concat(out) if out else pd.DataFrame()


def bands(R: pd.DataFrame, recent: list[int]) -> dict:
    """How each rating band did on seasons it never saw: win rate and return per $1, overall and recent."""
    if R.empty:
        return {"bands": [], "by_market": {}}

    def rows(d):
        out = []
        for lo, hi in BANDS:
            t = d[(d.rating >= lo) & (d.rating < hi)]
            r = t[t.season.isin(recent)]
            out.append({"lo": lo, "hi": min(hi, 10), "n": int(len(t)), "win": float(t.won.mean()) if len(t) else None,
                        "roi": float(t.ret.mean()) if len(t) else None, "recent_n": int(len(r)),
                        "recent_roi": float(r.ret.mean()) if len(r) else None})
        return out
    return {"bands": rows(R), "by_market": {m: rows(d) for m, d in R.groupby("market")},
            "first_season": int(R.season.min()), "recent_seasons": recent}
