import numpy as np
import pandas as pd

from engine import gamesim


def _team():
    base = {"team": "DET", "spread_for": 3.0, "team_attempts_pg": 34.0, "team_carries_pg": 27.0, "team_targets_pg": 32.0,
            "team_implied_total": 25.0, "opp_targets_mult": 1.0, "opp_receptions_mult": 1.0, "opp_rec_yards_mult": 1.0,
            "opp_carries_mult": 1.0, "opp_rush_yards_mult": 1.0, "opp_attempts_mult": 1.0, "opp_interceptions_mult": 1.0,
            "opp_pass_tds_mult": 1.0, "catch_rate": 0.66, "ypt": 8.0, "ypc": 4.4, "targets_share": 0.0, "carries_share": 0.0,
            "attempts_pg": 0.0, "interceptions_pg": 0.0, "pass_tds_pg": 0.0}
    rows = [
        {"player_id": "qb", "position": "QB", "attempts_pg": 34.0, "pass_tds_pg": 1.8, "interceptions_pg": 0.7, "carries_share": 0.08},
        {"player_id": "wr1", "position": "WR", "targets_share": 0.28},
        {"player_id": "wr2", "position": "WR", "targets_share": 0.18},
        {"player_id": "te", "position": "TE", "targets_share": 0.15},
        {"player_id": "rb", "position": "RB", "targets_share": 0.10, "carries_share": 0.6},
    ]
    return pd.DataFrame([{**base, **r} for r in rows])


def test_quarterback_line_is_his_receivers_total():
    out = gamesim.simulate_team(_team(), np.random.default_rng(1), n=2000)
    qb = out["qb"]
    rec = sum(out[p]["receptions"] for p in ("wr1", "wr2", "te", "rb"))
    assert np.all(qb["completions"] >= rec)  # plus targets to players outside the listed group
    assert np.all(qb["completions"] <= qb["attempts"])
    # The top target earner catches the most on average.
    assert out["wr1"]["receptions"].mean() > out["wr2"]["receptions"].mean() > 0
    assert 3.0 < out["rb"]["rush_yards"].mean() / max(out["rb"]["carries"].mean(), 1) < 6.0


def test_blend_matches_inputs_at_identity_weights():
    q = list(np.linspace(10, 108, 99))  # 99 percentiles of a simulated stat
    sim = {"q": q, "w": [1.0, 0.0, 0.0]}
    assert abs(gamesim.blend_p(0.62, sim, 50.5) - 0.62) < 1e-6
    sim = {"q": q, "w": [0.0, 1.0, 0.0]}
    p = gamesim.blend_p(0.9, sim, 59.5)
    assert 0.45 < p < 0.55  # about half the simulated games land above the middle


def test_volume_factor_uses_only_earlier_weeks():
    rows = []
    for wk, att in ((1, 40), (2, 40), (3, 99)):
        rows.append({"season": 2026, "week": wk, "labelled": 1, "game_id": f"g{wk}", "team": "DET", "team_attempts": att,
                     "team_attempts_pg": 32.0, "team_carries": 26, "team_carries_pg": 26.0})
    f = pd.DataFrame(rows)
    adj = gamesim.volume_factor(f, 2026, 3)  # week 3's own result must not count
    assert 1.0 < adj["pass_adj"] < 40 / 32
    assert adj["rush_adj"] == 1.0
    assert gamesim.volume_factor(f, 2026, 1) == {"pass_adj": 1.0, "rush_adj": 1.0}


def test_share_of_a_back_sitting_out_goes_to_the_backs_playing():
    rows = _team()
    rows.loc[rows.player_id == "rb", "carries_share"] = 0.45  # his usual share while a second back (now out) played
    off = gamesim.simulate_team(rows, np.random.default_rng(3), n=4000, params={"fill_car": 0.0})
    on = gamesim.simulate_team(rows, np.random.default_rng(3), n=4000, params={"fill_car": 1.0})
    assert on["rb"]["carries"].mean() > off["rb"]["carries"].mean() * 1.3
    # Shares that already add up to a full team are left alone.
    full = gamesim.simulate_team(_team(), np.random.default_rng(3), n=4000, params={"fill_tgt": 1.0})
    base = gamesim.simulate_team(_team(), np.random.default_rng(3), n=4000, params={"fill_tgt": 0.0})
    assert full["wr1"]["targets"].mean() >= base["wr1"]["targets"].mean()


def test_volume_noise_keeps_the_mean():
    # game-to-game volume noise widens the spread of team passes without raising their average (it used to add ~2%)
    noisy = gamesim.simulate_team(_team(), np.random.default_rng(1), n=40000, params={"vol_sd": 0.2})
    flat = gamesim.simulate_team(_team(), np.random.default_rng(1), n=40000, params={"vol_sd": 0.0})
    assert abs(noisy["qb"]["attempts"].mean() - flat["qb"]["attempts"].mean()) < 0.15
    assert noisy["qb"]["attempts"].std() > flat["qb"]["attempts"].std()
