"""The measured confidence table: how the model's leans at real sportsbook lines have actually hit, by how confident
the model was. It replaces the logistic re-fit curves (NBA 2026-11-05, NFL 2026-11-09) with something anyone can read:
"picks the model rated 65-70% have hit 58% of 412 at book lines".

A lean's shown chance is its band's real hit rate, nudged toward the model's own chance only as much as the band's
sample is small: (hits + K x model chance) / (n + K). Within a band the model's order is kept (a stronger lean still
ranks higher); across bands the record decides. A band that has hit under 50% shows 50% (a coin flip), never the
other side. The table is used only while it beats the model's own chances on graded days or weeks it never saw.

Why the change (2026-11-17 replay, Andrew asked for simpler measuring): the curves squeezed every chance into the high
50s and the NFL one tilted the whole list toward unders, while ranking by the curve or by the raw chance gave the same
record (NFL weekly top 10, Weeks 7-10: 28-12 curve, 27-13 raw). The table is as honest and shows its own evidence.
"""
from __future__ import annotations

import math

BANDS = [0.5, 0.55, 0.6, 0.65, 0.7, 1.0001]
SHRINK = 50.0   # pseudo-picks at the model's own chance: a band with few graded picks stays close to the model


def lean_of(p_over: float) -> float:
    return max(p_over, 1 - p_over)


def _band(lean: float) -> int:
    for i in range(len(BANDS) - 1):
        if BANDS[i] <= lean < BANDS[i + 1]:
            return i
    return len(BANDS) - 2


def fit(p_over: list[float], over: list[int]) -> list[dict]:
    """Per band: graded leans and how many hit, from each lean's chance of the over and whether the over hit."""
    out = [{"lo": BANDS[i], "hi": min(1.0, BANDS[i + 1]), "n": 0, "hits": 0} for i in range(len(BANDS) - 1)]
    for p, y in zip(p_over, over):
        b = out[_band(lean_of(p))]
        b["n"] += 1
        b["hits"] += int((p >= 0.5) == bool(y))
    for b in out:
        b["rate"] = round(b["hits"] / b["n"], 4) if b["n"] else None
    return out


def apply(p_over: float, bands: list[dict]) -> float:
    """The shown chance of the over: the lean's band record, shrunk toward the model's chance by sample size."""
    lean = lean_of(p_over)
    b = bands[_band(lean)]
    shown = max(0.5, (b["hits"] + SHRINK * lean) / (b["n"] + SHRINK))
    return shown if p_over >= 0.5 else 1 - shown


def logloss(y: list[int], p: list[float]) -> float:
    return -sum(math.log(min(1 - 1e-4, max(1e-4, q if v else 1 - q))) for v, q in zip(y, p)) / len(y)


def walk_forward(rows: list[dict], first_fit: int, log=print, label: str = "") -> dict | None:
    """rows: {"t": day or week (sortable), "p_over", "over"}. Each period is scored with a table built only from earlier
    periods; returns the table built from every row with its test numbers, or None when it does not beat the raw chances."""
    periods = sorted({r["t"] for r in rows})
    raw_ll = tab_ll = 0.0
    n_test = better = 0
    for t in periods[first_fit:]:
        tr = [r for r in rows if r["t"] < t]
        te = [r for r in rows if r["t"] == t]
        bands = fit([r["p_over"] for r in tr], [r["over"] for r in tr])
        y = [r["over"] for r in te]
        lr = logloss(y, [r["p_over"] for r in te])
        lt = logloss(y, [apply(r["p_over"], bands) for r in te])
        raw_ll += lr * len(te)
        tab_ll += lt * len(te)
        n_test += len(te)
        better += int(lt < lr)
    if not n_test:
        return None
    out = {"kind": "measured", "bands": fit([r["p_over"] for r in rows], [r["over"] for r in rows]), "shrink": SHRINK,
           "rows": len(rows), "periods": len(periods), "test_rows": n_test, "test_periods": len(periods) - first_fit,
           "periods_better": better, "log_loss_raw": round(raw_ll / n_test, 4), "log_loss_table": round(tab_ll / n_test, 4)}
    use = tab_ll < raw_ll
    log(f"{label} measured table: use={use} " + ", ".join(
        f"{b['lo']:.0%}+ {b['hits']}/{b['n']}" for b in out["bands"]) + f" (log loss {out['log_loss_table']} vs raw {out['log_loss_raw']})")
    return out if use else None
