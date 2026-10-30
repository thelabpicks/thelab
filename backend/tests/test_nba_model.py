import json

import numpy as np
import pandas as pd

from nba import history, pipeline, props


def _box(n_games=40, seed=0):
    """Two teams, five players each, one game every other day."""
    rng = np.random.default_rng(seed)
    rows = []
    for g in range(n_games):
        date = pd.Timestamp("2025-11-01") + pd.Timedelta(days=2 * g)
        for team, opp, home in (("BOS", "NY", 1), ("NY", "BOS", 0)):
            for k in range(5):
                mins = float(rng.integers(20, 38))
                rows.append({"game_id": 1000 + g, "season": 2026, "game_date": date, "player_id": (1 if team == "BOS" else 2) * 100 + k,
                             "player_name": f"{team} P{k}", "headshot": "", "pos": "G" if k < 2 else "F" if k < 4 else "C",
                             "team": team, "opp": opp, "home": home, "minutes": mins, "starter": 1, "played": True,
                             "points": float(rng.poisson(mins * 0.5)), "rebounds": float(rng.poisson(5)), "assists": float(rng.poisson(3)),
                             "threes": float(rng.poisson(1.5)), "threes_att": 5.0, "fga": 12.0, "fgm": 6.0, "fta": 3.0, "oreb": 1.0,
                             "turnovers": 2.0, "steals": 1.0, "blocks": 0.0})
    d = pd.DataFrame(rows)
    d["pra"] = d.points + d.rebounds + d.assists
    return d


def test_features_use_only_earlier_games():
    d = _box()
    f = history.build_features(d).sort_values(["player_id", "game_date"])
    p = f[f.player_id == 100].reset_index(drop=True)
    # the first game has no history; the second sees exactly the first game
    assert np.isnan(p.loc[0, "min_l"])
    assert p.loc[1, "min_l"] == p.loc[0, "minutes"]
    assert p.loc[1, "points_pm_l"] * p.loc[1, "min_l"] == p.loc[0, "points"]
    # changing a later game never changes an earlier game's features
    d2 = d.copy()
    d2.loc[(d2.player_id == 100) & (d2.game_id == 1039), "points"] = 99
    f2 = history.build_features(d2).sort_values(["player_id", "game_date"])
    early = f.game_id < 1039
    assert np.allclose(f[early].points_pm_l.fillna(-1).to_numpy(), f2[f2.game_id < 1039].points_pm_l.fillna(-1).to_numpy())
    assert np.allclose(f[early].sim_points.fillna(-1).to_numpy(), f2[f2.game_id < 1039].sim_points.fillna(-1).to_numpy())


def test_benched_games_count_as_zero_in_expected_minutes_only():
    d = _box(10)
    # player 100 sits the last four games by the coach's decision
    late = (d.player_id == 100) & (d.game_id >= 1006)
    d.loc[late, ["played", "minutes"]] = [False, 0.0]
    d["benched"] = late
    f = history.build_features(d).sort_values(["player_id", "game_date"])
    p = f[f.player_id == 100]
    assert len(p) == 6                        # benched games are not rows to predict
    nxt = history.build_features(pd.concat([d, pd.DataFrame([{**d[d.player_id == 100].iloc[-1].to_dict(), "game_id": 2000,
        "game_date": pd.Timestamp("2025-12-01"), "played": False, "benched": False, "upcoming": True}])], ignore_index=True))
    up = nxt[nxt.game_id == 2000].iloc[0]
    assert up.min_l > 20                      # minutes when he plays: unchanged
    assert up.min_exp < up.min_s / 2          # expected minutes: four games of 0 pull them down


def test_expected_minutes_follow_this_season_not_last():
    d = _box(10)
    # player 100 played big minutes last season and has sat all three games of this one by the coach's decision
    new = d.game_id >= 1007
    d.loc[new, "season"] = 2027
    sat = new & (d.player_id == 100)
    d.loc[sat, ["played", "minutes"]] = [False, 0.0]
    d["benched"] = sat
    up = pd.DataFrame([{**d[d.player_id == 100].iloc[-1].to_dict(), "game_id": 2000, "game_date": pd.Timestamp("2025-12-01"),
                        "played": False, "benched": False, "upcoming": True}])
    f = history.build_features(pd.concat([d, up], ignore_index=True))
    r = f[f.game_id == 2000].iloc[0]
    assert r.min_s > 20                       # his minutes when he plays still come from last season
    assert r.min_exp < 5                      # but this season he has not played: (Memphis's Mashack was given 31)


def test_a_season_debut_after_the_team_has_played_gets_part_of_his_career_minutes():
    d = _box(10)
    # a new season starts at game 1007; player 100 is not with the team (no rows) for its first three games
    new = d.game_id >= 1007
    d.loc[new, "season"] = 2027
    d = d[~(new & (d.player_id == 100))]
    up = pd.DataFrame([{**d[d.player_id == 100].iloc[-1].to_dict(), "game_id": 2000, "game_date": pd.Timestamp("2025-12-01"),
                        "season": 2027, "played": False, "upcoming": True}])
    f = history.build_features(pd.concat([d, up], ignore_index=True))
    r = f[f.game_id == 2000].iloc[0]
    career = d[d.player_id == 100].minutes.ewm(halflife=2).mean().iloc[-1]
    assert abs(r.min_exp - history.DEBUT_SHARE * career) < 0.01   # Lakers signing Lawson Lovering was given 26
    # on opening night everyone debuts: no cut
    old = d[d.season == 2026]
    opener = pd.DataFrame([{**up.iloc[0].to_dict(), "game_date": d[d.season == 2027].game_date.min()}])
    g = history.build_features(pd.concat([old, opener], ignore_index=True))
    assert abs(g[g.game_id == 2000].iloc[0].min_exp - career) < 0.01


def test_rookies_are_projected_from_their_second_game():
    f = history.build_features(_box(10))
    rows = props.model_rows(f, "points")
    assert rows.games_prior.min() == 1


def test_usual_line_is_median_of_previous_ten_rounded_down_plus_half():
    p = pd.DataFrame({"player_id": [1] * 12, "points": [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 99]})
    line = props.usual_line(p, "points")
    assert np.isnan(line.iloc[4])
    assert line.iloc[11] == np.floor(np.median([12, 14, 16, 18, 20, 22, 24, 26, 28, 30])) + 0.5


def test_published_chance_matches_engine_calibration():
    mu, bands, platt = np.array([22.0]), [0.05] * 5, [0.9, -0.05]
    n, pr = props.nb_params(mu, props.alpha_for([30], bands))
    from scipy import stats as st
    dist = {"type": "nbinom", "cdf": list(st.nbinom.cdf(np.arange(90), n[0], pr[0])), "platt": platt}
    raw = props.p_over_raw(mu, props.alpha_for([30], bands), np.array([21.5]))
    assert abs(pipeline.p_over_dist(dist, 21.5) - props.apply_platt(raw, platt)[0]) < 1e-9


def test_alpha_bands_widen_for_short_minutes():
    rng = np.random.default_rng(1)
    mu = np.full(4000, 10.0)
    mins = np.r_[np.full(2000, 10.0), np.full(2000, 34.0)]
    y = np.r_[rng.negative_binomial(2, 2 / 12, 2000), rng.poisson(10, 2000)]
    b = props.fit_alpha_bands(y, mu, mins)
    assert b[0] > 0.3 and b[-1] < 0.05


def test_freeze_keeps_first_projection_without_tip_times(tmp_path, monkeypatch):
    monkeypatch.setenv("NBA_ARCHIVE_DIR", str(tmp_path))
    row = {"player_id": "1", "player_name": "A", "team": "BOS", "game_id": 5, "market": "points", "line": 20.5,
           "line_source": "usual", "p_over": 0.61, "offers": [], "out": False}
    assert pipeline.freeze("2026-10-22", [row])["picks"] == 1
    assert pipeline.freeze("2026-10-22", [dict(row, p_over=0.2)])["kept"]
    assert json.loads((tmp_path / "picks" / "2026-10-22.json").read_text())["picks"][0]["p_over"] == 0.61


def test_pre_tip_refresh_replaces_only_games_not_started(tmp_path, monkeypatch):
    from datetime import datetime, timezone
    monkeypatch.setenv("NBA_ARCHIVE_DIR", str(tmp_path))
    row = {"player_id": "1", "player_name": "A", "team": "BOS", "market": "points", "line": 20.5,
           "line_source": "usual", "offers": [], "out": False, "mean": 22.0}
    early, late = datetime(2026, 10, 22, 23, 0, tzinfo=timezone.utc), datetime(2026, 10, 23, 2, 0, tzinfo=timezone.utc)
    tips = {5: early, 6: late}
    morning = [dict(row, game_id=5, p_over=0.61), dict(row, game_id=6, player_id="2", p_over=0.55)]
    pipeline.freeze("2026-10-22", morning, tips, now=datetime(2026, 10, 22, 16, 0, tzinfo=timezone.utc))
    # 23:30: game 5 is under way, game 6 gets the late injury news
    evening = [dict(row, game_id=5, p_over=0.30), dict(row, game_id=6, player_id="2", p_over=0.40)]
    st = pipeline.freeze("2026-10-22", evening, tips, now=datetime(2026, 10, 22, 23, 30, tzinfo=timezone.utc))
    assert st["kept_started"] == 1 and st["picks"] == 1
    saved = {p["game_id"]: p["p_over"] for p in json.loads((tmp_path / "picks" / "2026-10-22.json").read_text())["picks"]}
    assert saved == {5: 0.61, 6: 0.40}


def test_projection_check_reports_bias_and_miss():
    r = pd.DataFrame({"date": ["d1"] * 4, "market": ["points"] * 4, "player_id": list("abcd"), "mean": [20.0, 10.0, 15.0, 5.0],
                      "actual": [24.0, 12.0, 15.0, 5.0]})
    out = pipeline.projection_check(r)[0]
    assert out["bias"] == 1.5 and out["avg_miss"] == 1.5 and out["n"] == 4


def test_team_check_recovers_the_scoring_squeeze_and_scales_an_overloaded_team():
    from nba import teamfit
    rng = np.random.default_rng(3)
    load = rng.normal(0, 0.15, 20000)
    mu = rng.uniform(5, 30, 20000)
    y = rng.poisson(mu * np.exp(-0.02 - 0.3 * load))
    a, b = teamfit.fit_poisson(y.astype(float), mu, load)
    assert abs(a + 0.02) < 0.01 and abs(b + 0.3) < 0.03

    from scipy import stats as st
    def row(pid, team, market, mu_):
        n = 20.0
        return {"game_id": 1, "team": team, "player_id": pid, "market": market, "mu": mu_, "min_l": 30.0, "out": False,
                "pts_for": 100.0, "q10": 0.0, "q90": 0.0,
                "dist": {"type": "nbinom", "n": n, "p": n / (n + mu_), "cdf": list(st.nbinom.cdf(np.arange(60), n, n / (n + mu_))), "platt": [1, 0]}}
    # BOS's rotation projects 130 points against a usual 100; NY's projects exactly 100
    res = pd.DataFrame([row(i, "BOS", "points", 26.0) for i in range(5)] + [row(10 + i, "NY", "points", 20.0) for i in range(5)]
                       + [row(0, "BOS", "pra", 40.0), row(0, "BOS", "rebounds", 8.0)])
    out = teamfit.apply(res, {"use": True, "a": 0.0, "b": -0.3}, log=lambda *_: None)
    f = np.exp(-0.3 * np.log(1.3))
    bos = out[(out.team == "BOS") & (out.market == "points")]
    assert np.allclose(bos.mu, 26.0 * f)
    assert np.allclose(out[(out.team == "NY") & (out.market == "points")].mu, 20.0)
    pra = out[(out.market == "pra")].iloc[0]
    assert abs(pra.mu - (40.0 + (f - 1) * 26.0)) < 1e-9
    assert out[out.market == "rebounds"].mu.iloc[0] == 8.0
    # the published distribution moves with the mean
    d = bos.dist.iloc[0]
    assert abs(d["n"] * (1 - d["p"]) / d["p"] - 26.0 * f) < 1e-6
    # not used when it did not beat the plain model
    assert teamfit.apply(res, {"use": False}).mu.tolist() == res.mu.tolist()


def test_todays_roster_moves_a_traded_player_to_his_new_team():
    from nba import predict
    d = _box()
    slate = pd.DataFrame([{"game_id": 9999, "game_date": pd.Timestamp("2026-01-30"), "game_date_time": "2026-01-31T00:00Z",
                           "home_abbreviation": "BOS", "away_abbreviation": "NY"}])
    plain = predict.slate_rows(d, slate, 2026, roster={})
    assert set(plain[plain.team == "BOS"].player_id) == {100, 101, 102, 103, 104}
    # player 104 was traded to NY and player 103 was waived; neither has played since
    roster = {100: "BOS", 101: "BOS", 102: "BOS", 104: "NY", 200: "NY", 201: "NY", 202: "NY", 203: "NY", 204: "NY"}
    rows = predict.slate_rows(d, slate, 2026, roster=roster)
    assert set(rows[rows.team == "BOS"].player_id) == {100, 101, 102}
    moved = rows[rows.player_id == 104].iloc[0]
    assert (moved.team, moved.opp, moved.home) == ("NY", "BOS", 0)


def test_post_game_review_splits_a_miss_into_minutes_and_production():
    r = pd.DataFrame({"date": ["d1"] * 3, "market": ["points"] * 3, "player_id": list("abc"), "mean": [20.0, 10.0, 15.0],
                      "actual": [8.0, 12.0, 15.0], "won": [0, 1, 1], "line": [18.5, 9.5, 14.5], "proj_minutes": [34.0, 24.0, 30.0],
                      "minutes": [14.0, 26.0, 30.0], "team": ["BOS"] * 3, "game_id": [1] * 3, "injury": [None, "Questionable", None]})
    d = pd.DataFrame({"game_id": [1] * 3, "team": ["BOS"] * 3, "points": [8, 12, 15], "played": [True] * 3})
    out = pipeline.post_game_review(r, d)
    # a played 14 of a projected 34 minutes: at his projected rate that is 8.2 points, so minutes explain the miss
    assert out["lost"] == 1 and out["lost_minutes_explain"] == 1
    assert out["biggest_misses"][0]["cause"] == "minutes"
    assert out["minutes"]["bias"] == -6.0 and out["team_rotation"]["bias"] == -10.0


def test_previous_days_groups_leans_by_day_and_game():
    import pandas as pd
    from nba import pipeline
    r = pd.DataFrame([
        {"date": "2026-10-24", "game_id": 7, "player_id": "1", "player_name": "A", "team": "LAL", "opp": "UTAH", "home": 0, "team_score": 132,
         "opp_score": 123, "market": "points", "side": "over", "line": 20.5, "lean": 0.58, "mean": 22.1, "actual": 25.0, "won": 1, "line_source": "usual"},
        {"date": "2026-10-24", "game_id": 7, "player_id": "2", "player_name": "B", "team": "UTAH", "opp": "LAL", "home": 1, "team_score": 123,
         "opp_score": 132, "market": "assists", "side": "under", "line": 4.5, "lean": 0.66, "mean": 3.2, "actual": 6.0, "won": 0, "line_source": "usual"},
    ])
    out = pipeline.previous_days(r)
    g = out["days"][0]["games"][0]
    assert (g["home"], g["away"], g["score"]) == ("UTAH", "LAL", [123.0, 132.0])
    assert [p[1] for p in g["picks"]] == ["B", "A"]   # likeliest first
    assert g["picks"][0][-1] == 0


def test_model_rows_carry_this_season_evidence_for_the_site():
    # slate_json reads season_games, season_starts and season_min off each projected row
    rows = props.model_rows(history.build_features(_box()), "points")
    assert {"season_games", "season_starts", "season_min"} <= set(rows.columns)
    last = rows[rows.player_id == 100].sort_values("game_date").iloc[-1]
    assert last.season_starts == last.season_games == 39


def test_rotation_lists_every_player_not_ruled_out_for_the_game_sims():
    rows = []
    for pid, out in ((1, False), (2, True)):
        for market, mu in (("points", 12.0), ("rebounds", 4.0), ("assists", 3.0), ("threes", 1.5), ("pra", 19.0)):
            rows.append({"player_id": pid, "player_name": f"P{pid}", "team": "BOS", "out": out, "market": market, "mu": mu,
                         "min_s": 20.0, "min_exp": 15.0})
    rot = pipeline.rotation_json(pd.DataFrame(rows))
    assert rot == [{"player_id": "1", "player_name": "P1", "team": "BOS", "minutes": 20.0, "minutes_expected": 15.0,
                    "pts": 12.0, "reb": 4.0, "ast": 3.0, "tpm": 1.5}]
