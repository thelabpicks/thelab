import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from engine import gamesim, picklog, simreview
from tests.test_gamesim import _team


def _rows(game_id="2026_07_DET_CHI"):
    r = _team()
    r["game_id"], r["has_history"], r["player_name"] = game_id, 1, r.player_id
    r["snap_pct"] = 0.8
    return r


def _box(game_id="2026_07_DET_CHI", rb_plays=True):
    stats = {"qb": dict(attempts=40, completions=26, pass_yards=300, pass_tds=3, interceptions=0, carries=3, rush_yards=10),
             "wr1": dict(targets=14, receptions=10, rec_yards=150), "wr2": dict(targets=6, receptions=4, rec_yards=40),
             "te": dict(targets=8, receptions=6, rec_yards=60), "rb": dict(targets=4, receptions=3, rec_yards=20, carries=12, rush_yards=70)}
    rows = []
    for pid, s in stats.items():
        if pid == "rb" and not rb_plays:
            continue
        base = {k: 0.0 for k in simreview.STATS}
        base.update(s)
        base["rush_rec_yards"] = base["rush_yards"] + base["rec_yards"]
        rows.append({"game_id": game_id, "player_id": pid, "team": "DET", "offense_pct": 0.9, **base})
    box = pd.DataFrame(rows)
    vol = {(game_id, "DET"): {"attempts": float(box.attempts.sum()), "carries": float(box.carries.sum()) + 2,
                               "targets": float(box.targets.sum()), "points": 31.0, "allowed": 17.0}}
    return box.set_index(["game_id", "player_id"]), vol


def test_freeze_keeps_games_that_kicked_off(tmp_path, monkeypatch):
    monkeypatch.setenv("FG_SIMS_DIR", str(tmp_path))
    early, late = datetime(2026, 10, 25, 17, tzinfo=timezone.utc), datetime(2026, 10, 26, 0, 20, tzinfo=timezone.utc)
    monkeypatch.setattr(picklog, "_kickoffs", lambda c, s, w: {"2026_07_DET_CHI": early, "2026_07_KC_SEA": late})
    rows = pd.concat([_rows("2026_07_DET_CHI"), _rows("2026_07_KC_SEA").assign(team="KC")])
    simreview.freeze(None, rows, 2026, 7, {"pass_adj": 1.0}, n=500, now=datetime(2026, 10, 25, 12, tzinfo=timezone.utc), log=lambda m: None)
    first = json.loads(simreview.week_path(2026, 7).read_text())
    assert set(first["games"]) == {"2026_07_DET_CHI", "2026_07_KC_SEA"}
    det = first["games"]["2026_07_DET_CHI"]["teams"]["DET"]
    assert det["players"]["wr1"]["targets"]["mean"] > det["players"]["wr2"]["targets"]["mean"]
    assert det["team"]["attempts"]["mean"] > 20
    # A later run (after DET-CHI kicked off) with new inputs only replaces the game that has not started.
    changed = rows.assign(team_attempts_pg=60.0)
    simreview.freeze(None, changed, 2026, 7, {"pass_adj": 1.0}, n=500, now=datetime(2026, 10, 25, 20, tzinfo=timezone.utc), log=lambda m: None)
    second = json.loads(simreview.week_path(2026, 7).read_text())
    assert second["games"]["2026_07_DET_CHI"] == first["games"]["2026_07_DET_CHI"]
    assert second["games"]["2026_07_KC_SEA"]["teams"]["KC"]["inputs"][0]["team_attempts_pg"] == 60.0


def _frozen(rows):
    recs = [{k: simreview._clean(v) for k, v in r.items()} for r in rows[[c for c in simreview.INPUT_COLS if c in rows]].to_dict("records")]
    return {"game_id": "2026_07_DET_CHI", "kickoff": None, "frozen_at": "x", "params": {"pass_adj": 1.0, "rush_adj": 1.0}, "sims": 2000,
            "teams": {"DET": {"inputs": recs}}}


def test_real_usage_explains_volume_misses_and_efficiency_leaves_only_chance():
    box, vol = _box()
    g = simreview.review_game(_frozen(_rows()), box, vol)
    rows = {(r["player"], r["market"]): r for r in g["rows"]}
    car = rows[("rb", "carries")]
    assert car["miss"]["roles"] == 0 and car["miss"]["pregame"] > 5  # 12 real carries; the sim expected far more
    assert rows[("qb", "pass_attempts")]["miss"]["volume"] == 0
    rec = rows[("wr1", "rec_yards")]
    assert rec["miss"]["efficiency"] < rec["miss"]["pregame"]
    inp = {(x["input"], x.get("player")): x for x in g["inputs"]}
    assert inp[("team_attempts", None)]["actual"] == 40 and inp[("team_attempts", None)]["pre"] < 40
    assert inp[("carry_share", "rb")]["actual"] < inp[("carry_share", "rb")]["pre"]
    assert abs(inp[("catch_rate", "wr1")]["actual"] - 100 * 10 / 14) < 1e-2


def test_a_player_who_sat_out_is_named_and_his_share_moves():
    box, vol = _box(rb_plays=False)
    g = simreview.review_game(_frozen(_rows()), box, vol)
    assert g["teams"][0]["sat_out"] == ["rb"]
    assert next(x for x in g["inputs"] if x["input"] == "sat_out")["actual"] == 1
    assert not any(r["player"] == "rb" for r in g["rows"])
    assert any("sat out" in n for n in simreview._game_notes(g))


def test_no_review_until_the_box_score_is_in():
    box, _ = _box()
    assert simreview.review_game(_frozen(_rows()), box, {}) is None


def test_market_and_input_tables_attribute_the_miss():
    box, vol = _box()
    g = simreview.review_game(_frozen(_rows()), box, vol)
    mk = {m["market"]: m for m in simreview._market_table(g["rows"])}
    assert mk["carries"]["miss"]["roles"] == 0 and mk["carries"]["chance"] == 0
    assert 0 <= sum(mk["rec_yards"]["share"].values()) <= 1.0001
    it = {x["input"]: x for x in simreview._input_table(g["inputs"], g["inputs"], {"pass_adj": 1.03}, {"ypc_adj": {"adopt": True, "gain": 0.001}, "volume": {"adopt": True, "gain": 0.002}})}
    assert it["team_attempts"]["correction"] == {"key": "pass_adj", "value": 1.03, "adopted": True, "gain": 0.002}
    assert it["ypc"]["correction"]["adopted"] is True
    assert it["catch_rate"]["correction"]["adopted"] is False
    assert not it["team_attempts"]["clear"]  # one game is never enough to call a bias


def test_exact_usage_columns_fix_team_volume():
    rows = _team().assign(att_exact=41.0, car_exact=19.0, tgt_exact=37.0)
    out = gamesim.simulate_team(rows, np.random.default_rng(1), n=500, with_team=True)
    assert np.all(out["qb"]["attempts"] == 41) and np.all(out[gamesim.TEAM]["carries"] == 19)
    assert np.all(out[gamesim.TEAM]["targets"] == 37)


def test_efficiency_factor_uses_only_earlier_weeks_and_moves_the_sim():
    rows = []
    for wk, rec in ((1, 9), (2, 9), (3, 0)):
        rows.append({"season": 2026, "week": wk, "labelled": 1, "has_history": 1, "targets": 10, "receptions": rec, "catch_rate": 0.6,
                     "rec_yards": 80, "ypt": 8.0, "carries": 10, "rush_yards": 40, "ypc": 4.0, "game_id": f"g{wk}", "team": "DET",
                     "team_attempts": 32, "team_attempts_pg": 32.0, "team_carries": 26, "team_carries_pg": 26.0})
    f = pd.DataFrame(rows)
    adj = gamesim.efficiency_factor(f, 2026, 3)   # week 3's own result must not count
    assert 1.0 < adj["catch_adj"] < 0.9 / 0.6 and adj["ypt_adj"] == 1.0 and adj["ypc_adj"] == 1.0
    assert gamesim.efficiency_factor(f, 2026, 1) == {"catch_adj": 1.0, "ypt_adj": 1.0, "ypc_adj": 1.0}
    assert gamesim.week_params(f, 2026, 3) == {}   # nothing adopted: no corrections, not even volume
    assert gamesim.week_params(f, 2026, 3, ["volume"]) == gamesim.volume_factor(f, 2026, 3)
    assert gamesim.week_params(f, 2026, 3, ["catch_adj"])["catch_adj"] == adj["catch_adj"]
    hi = gamesim.simulate_team(_team(), np.random.default_rng(4), n=3000, params={"catch_adj": 1.2})
    lo = gamesim.simulate_team(_team(), np.random.default_rng(4), n=3000)
    assert hi["wr1"]["receptions"].mean() > lo["wr1"]["receptions"].mean()
