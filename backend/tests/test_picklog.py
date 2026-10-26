from engine import picklog


def test_tiers_match_the_site():
    assert picklog.tier("td", 0.55) == "Strong"
    assert picklog.tier("td", 0.10) == "Long shot"
    assert picklog.tier("props", 0.60) == "Solid"
    assert picklog.tier("props", 0.51) == "Coin flip"


def test_drift_needs_enough_picks_and_a_real_gap():
    few = [{"p": 0.7, "result": 0}] * 20
    assert picklog._summary(few)["drift"] is None
    cold = [{"p": 0.7, "result": int(i % 2 == 0)} for i in range(200)]  # 50% hit on 70% chances
    assert picklog._summary(cold)["drift"] == "running cold"
    fair = [{"p": 0.5, "result": int(i % 2 == 0)} for i in range(200)]
    assert picklog._summary(fair)["drift"] is None


def test_estimated_line_follows_a_role_change():
    # A backup QB now starting: recent median 4 attempts, projection 24 -> the projection's line, not 4.5.
    assert picklog._estimated_line(23.9, 4.0) == (23.5, "projected")
    assert picklog._estimated_line(37.2, 38.5) == (38.5, "usual")


def test_scored_game_without_box_score_stays_pending(monkeypatch):
    import sqlite3
    import pandas as pd
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE games (game_id, season, week, home_score)")
    c.execute("CREATE TABLE player_game (player_id, game_id, season, week, participated, scored_anytime)")
    c.execute("INSERT INTO games VALUES ('g', 2026, 7, 24)")
    monkeypatch.setattr(picklog.props, "load_history", lambda _c: pd.DataFrame(columns=["season", "week", "player_id"]))
    pick = {"game_id": "g", "player_id": "1", "kind": "td", "market": "td"}
    assert picklog.grade(c, [pick], 2026, 7)[0]["status"] == "pending"
    # once the box score is in, a player with no row sat out
    c.execute("INSERT INTO player_game VALUES ('2', 'g', 2026, 7, 1, 0)")
    assert picklog.grade(c, [pick], 2026, 7)[0]["status"] == "void"


def test_previous_weeks_groups_picks_by_week_and_game():
    import sqlite3
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE games (game_id, season, week, home_team, away_team, home_score, away_score, gameday)")
    c.execute("INSERT INTO games VALUES ('2026_07_NE_CHI', 2026, 7, 'CHI', 'NE', 24, 17, '2026-10-22')")
    rows = [{"season": 2026, "week": 7, "game_id": "2026_07_NE_CHI", "player_id": str(i), "player_name": f"P{i}", "team": "CHI",
             "market": "rush_yds", "side": "over", "line": 50.5, "p": p, "median": 55.0, "actual": 61.0, "result": 1,
             "featured": False, "kickoff": "2026-10-23T00:15:00+00:00"} for i, p in ((1, 0.55), (2, 0.7))]
    out = picklog._previous(c, rows)
    assert [(w["season"], w["week"]) for w in out] == [(2026, 7)]
    g = out[0]["games"][0]
    assert (g["home"], g["away"], g["score"]) == ("CHI", "NE", [24, 17])
    assert [p[0] for p in g["picks"]] == ["2", "1"]   # likeliest first
    assert g["picks"][0][9] == 1
