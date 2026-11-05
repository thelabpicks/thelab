"""Last night's box scores come from ESPN's finals until the sportsdataverse file catches up."""
import json

import pandas as pd

from nba import collect, history, sources


def _summary(completed=True):
    keys = ["minutes", "points", "fieldGoalsMade-fieldGoalsAttempted", "threePointFieldGoalsMade-threePointFieldGoalsAttempted",
            "freeThrowsMade-freeThrowsAttempted", "rebounds", "assists", "turnovers", "steals", "blocks", "offensiveRebounds"]
    labels = ["MIN", "PTS", "FG", "3PT", "FT", "REB", "AST", "TO", "STL", "BLK", "OREB"]
    team = lambda abbr, athletes: {"team": {"abbreviation": abbr}, "statistics": [{"keys": keys, "labels": labels, "athletes": athletes}]}  # noqa: E731
    ath = lambda i, name, stats, **kw: {"athlete": {"id": str(i), "displayName": name, "position": {"abbreviation": "G"}}, "stats": stats, **kw}  # noqa: E731
    return {"header": {"id": "401", "competitions": [{"id": "401", "date": "2026-11-05T00:00Z", "status": {"type": {"completed": completed}},
                                                      "competitors": [{"team": {"abbreviation": "MIA"}, "homeAway": "away", "score": "117"},
                                                                      {"team": {"abbreviation": "LAC"}, "homeAway": "home", "score": "116"}]}]},
            "boxscore": {"players": [team("MIA", [ath(1, "Tyler Herro", ["36", "25", "9-18", "4-9", "3-3", "5", "4", "2", "1", "0", "1"], starter=True),
                                                  ath(2, "Bench Guy", [], didNotPlay=True, reason="COACH'S DECISION")]),
                                     team("LAC", [ath(3, "Other", ["30", "10", "4-10", "2-5", "0-0", "3", "2", "1", "0", "0", "0"])])]}}


def test_parse_final_box_score():
    rows = collect.parse_espn_box(_summary(), "2026-11-04")
    herro = next(r for r in rows if r["athlete_id"] == 1)
    assert (herro["points"], herro["three_point_field_goals_made"], herro["three_point_field_goals_attempted"], herro["minutes"]) == (25, 4, 9, 36)
    assert herro["team_abbreviation"] == "MIA" and herro["opponent_team_abbreviation"] == "LAC" and herro["team_score"] == 117
    bench = next(r for r in rows if r["athlete_id"] == 2)
    assert bench["did_not_play"] and bench["minutes"] == 0
    assert collect.parse_espn_box(_summary(completed=False), "2026-11-04") == []


def test_load_box_adds_games_the_file_does_not_have(tmp_path, monkeypatch):
    monkeypatch.setenv("NBA_ARCHIVE_DIR", str(tmp_path / "archive"))
    rows = collect.parse_espn_box(_summary(), "2026-11-04")
    (tmp_path / "archive" / "espn_box").mkdir(parents=True)
    (tmp_path / "archive" / "espn_box" / "2026-11-04.json").write_text(json.dumps({"games": {"401": rows}}))
    base = pd.DataFrame([{**rows[0], "game_id": 400, "game_date": "2026-11-02"}])
    d = history.add_espn_box(base)
    assert set(d.game_id) == {400, 401}
    # a game already in the file is not added twice
    assert len(history.add_espn_box(pd.concat([base, pd.DataFrame(rows)]))) == 1 + len(rows)
