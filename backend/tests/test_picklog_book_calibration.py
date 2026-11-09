import random

from engine import picklog


def _rows(n_weeks=3, per_week=150, true_slope=0.4, seed=1):
    """Leans whose real hit rate is far closer to even than the chance given (overconfident at book lines)."""
    rnd = random.Random(seed)
    out = []
    for w in range(7, 7 + n_weeks):
        for _ in range(per_week):
            p = rnd.uniform(0.5, 0.85)
            side = rnd.choice(["over", "under"])
            z = true_slope * picklog._logit(p)
            hit = int(rnd.random() < 1 / (1 + 2.718281828 ** -z))
            out.append({"kind": "props", "line_source": "book", "p": p, "side": side, "result": hit, "season": 2026, "week": w})
    return out


def test_overconfident_book_leans_are_refit_toward_even_with_order_kept():
    cal = picklog.book_calibration(_rows(), log=lambda *_: None)
    assert cal and cal["log_loss_refit"] < cal["log_loss_raw"] and 0 < cal["a"] < 1
    hi, lo = picklog.apply_book_cal(0.8, cal), picklog.apply_book_cal(0.65, cal)
    assert 0.5 < lo < hi < 0.8


def test_no_refit_with_too_few_weeks_or_on_usual_lines():
    assert picklog.book_calibration(_rows(n_weeks=2), log=lambda *_: None) is None
    usual = [dict(r, line_source="usual") for r in _rows()]
    assert picklog.book_calibration(usual, log=lambda *_: None) is None


def test_no_refit_when_the_chances_are_already_right():
    assert picklog.book_calibration(_rows(true_slope=1.0, per_week=400), log=lambda *_: None) is None
