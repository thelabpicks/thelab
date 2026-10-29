import numpy as np
import pandas as pd

from engine import gamesim, props


def _frame():
    """Two defenses, three weeks. WRs of every role go well over their usual receptions against DAL, under against NYG."""
    rows = []
    for wk in (1, 2, 3):
        for opp, extra in (("DAL", 3), ("NYG", -2)):
            for i, tpg in enumerate((3.0, 6.0, 9.0)):
                rows.append({"season": 2025, "week": wk, "team": f"T{opp}{wk}", "opponent": opp, "position": "WR",
                             "player_id": f"{opp}{wk}{i}", "labelled": 1, "has_history": 1, "targets_pg": tpg,
                             "touches_pg": tpg, "attempts_pg": 0.0, "receptions_pg": tpg * 0.6, "receptions": tpg * 0.6 + extra,
                             "targets": tpg, "pass_yards_pg": 0.0, "pass_yards": 0.0, "attempts": 0.0})
    return pd.DataFrame(rows)


def test_similar_defense_uses_only_earlier_weeks():
    t = _frame()
    f = t.join(props._defense_similar(t))
    wk1 = f[f.week == 1]
    assert wk1.opp_sim_receptions_mult.isna().all()  # nothing earlier to learn from
    dal = f[(f.week == 3) & (f.opponent == "DAL")].opp_sim_receptions_mult
    nyg = f[(f.week == 3) & (f.opponent == "NYG")].opp_sim_receptions_mult
    assert (dal > 1.0).all() and (nyg < 1.0).all()
    # Week 2 sees only week 1; changing week 3's results must not move it.
    t2 = t.copy()
    t2.loc[t2.week == 3, "receptions"] = 0.0
    f2 = t2.join(props._defense_similar(t2))
    assert np.allclose(f[f.week == 2].opp_sim_receptions_mult, f2[f2.week == 2].opp_sim_receptions_mult)


def test_last_carries_share_is_the_teams_previous_game():
    hist = pd.DataFrame([
        {"season": 2026, "week": 6, "team": "GB", "player_id": "lloyd", "carries": 8},
        {"season": 2026, "week": 6, "team": "GB", "player_id": "strong", "carries": 12},
        {"season": 2026, "week": 7, "team": "GB", "player_id": "jacobs", "carries": 11},
        {"season": 2026, "week": 7, "team": "GB", "player_id": "lloyd", "carries": 6},
        {"season": 2026, "week": 7, "team": "GB", "player_id": "strong", "carries": 0},
        {"season": 2026, "week": 7, "team": "GB", "player_id": "qb", "carries": 5},
    ])
    t = pd.DataFrame([{"season": 2026, "week": 8, "team": "GB", "player_id": p} for p in ("jacobs", "lloyd", "strong", "johnson")])
    f = t.join(props._last_carries_share(hist, t))
    share = dict(zip(f.player_id, f.last_carries_share))
    assert abs(share["jacobs"] - 0.5) < 1e-9 and abs(share["lloyd"] - 6 / 22) < 1e-9 and share["strong"] == 0
    assert np.isnan(share["johnson"])  # did not play the last game: keeps his own window share


def test_sim_blends_the_last_game_share():
    base = {"team": "GB", "spread_for": 0.0, "team_attempts_pg": 34.0, "team_carries_pg": 26.0, "team_targets_pg": 32.0,
            "team_implied_total": 23.0, "opp_carries_mult": 1.0, "opp_rush_yards_mult": 1.0, "ypc": 4.3, "targets_share": 0.0,
            "attempts_pg": 0.0, "position": "RB", "opp_targets_mult": 1.0}
    rows = pd.DataFrame([{**base, "player_id": "a", "carries_share": 0.3, "last_carries_share": 0.7},
                         {**base, "player_id": "b", "carries_share": 0.5, "last_carries_share": 0.1}])
    with_last = gamesim.simulate_team(rows, np.random.default_rng(3), n=3000)
    without = gamesim.simulate_team(rows, np.random.default_rng(3), n=3000, params={"last_car_w": 0.0})
    assert with_last["a"]["carries"].mean() > without["a"]["carries"].mean()
    assert with_last["b"]["carries"].mean() < without["b"]["carries"].mean()
