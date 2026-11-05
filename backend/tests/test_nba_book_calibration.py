"""Chances at book lines are re-fitted on graded frozen leans only when that beats the raw chances day by day."""
import json

import numpy as np
import pandas as pd

from nba import pipeline


def _archive(tmp_path, monkeypatch, overconfident: bool, days: int = 6, per_day: int = 250):
    monkeypatch.setenv("NBA_ARCHIVE_DIR", str(tmp_path / "archive"))
    rng = np.random.default_rng(1)
    pdir = tmp_path / "archive" / "picks"
    pdir.mkdir(parents=True)
    box = []
    pid = 0
    for k in range(days):
        day = f"2026-10-{10 + k:02d}"
        picks = []
        for _ in range(per_day):
            pid += 1
            raw = float(rng.uniform(0.2, 0.8))
            truth = 0.5 + (raw - 0.5) * (0.4 if overconfident else 1.0)   # overconfident: real chance half as far from 50%
            over = rng.random() < truth
            picks.append({"player_id": str(pid), "game_id": 1000 + k, "market": "points", "line": 10.5,
                          "line_source": "book", "p_over": raw})
            box.append({"game_id": 1000 + k, "player_id": pid, "played": True, "points": 12.0 if over else 9.0})
        picks.append({"player_id": "999999", "game_id": 1000 + k, "market": "points", "line": 10.5,
                      "line_source": "usual", "p_over": 0.9})   # usual-line leans never enter the fit
        (pdir / f"{day}.json").write_text(json.dumps({"date": day, "picks": picks}))
    return pd.DataFrame(box)


def test_overconfident_chances_are_pulled_toward_even(tmp_path, monkeypatch):
    d = _archive(tmp_path, monkeypatch, overconfident=True)
    cal = pipeline.book_calibration(d, log=lambda *a: None)
    assert cal is not None and cal["rows"] == 1500 and cal["log_loss_refit"] < cal["log_loss_raw"]
    assert 0.2 < cal["a"] < 0.7
    p = pipeline.apply_book_cal(0.75, cal)
    assert 0.55 < p < 0.68
    assert pipeline.apply_book_cal(0.8, cal) > pipeline.apply_book_cal(0.7, cal) > 0.5   # ranks are kept


def test_well_calibrated_chances_need_no_refit_and_few_days_are_skipped(tmp_path, monkeypatch):
    d = _archive(tmp_path, monkeypatch, overconfident=False)
    cal = pipeline.book_calibration(d, log=lambda *a: None)
    assert cal is None or abs(cal["a"] - 1) < 0.25
    (tmp_path / "archive").rename(tmp_path / "old")
    d = _archive(tmp_path, monkeypatch, overconfident=True, days=3, per_day=500)
    assert pipeline.book_calibration(d, log=lambda *a: None) is None


def test_refit_uses_the_raw_chance_saved_with_each_lean(tmp_path, monkeypatch):
    d = _archive(tmp_path, monkeypatch, overconfident=True)
    f = sorted((tmp_path / "archive" / "picks").glob("*.json"))[0]
    s = json.loads(f.read_text())
    for p in s["picks"]:
        p["p_over_raw"], p["p_over"] = p["p_over"], 0.5
    f.write_text(json.dumps(s))
    r = pipeline.book_rows(d)
    assert r.raw.std() > 0.1 and (r.raw != 0.5).all()
