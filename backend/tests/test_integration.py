"""Synthetic end-to-end checks (TEST DATA ONLY, not NFL results): import idempotency, failed-import
safety, opportunity counting, participation, prior-only defense splits, API masking and lock immutability."""
from __future__ import annotations

import csv
import importlib
import sqlite3

import pytest

PBP_COLS = ["season", "week", "game_id", "play_id", "season_type", "posteam", "defteam", "play_type", "yardline_100",
            "pass_attempt", "rush_attempt", "receiver_player_id", "receiver_player_name", "receiver_player_position",
            "rusher_player_id", "rusher_player_name", "rusher_player_position", "air_yards", "complete_pass",
            "pass_touchdown", "rush_touchdown", "touchdown", "td_player_id", "no_play", "two_point_attempt", "qb_spike",
            "fixed_drive", "fixed_drive_result", "drive_inside20", "desc"]


def _write(path, cols, rows):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})


def _pass(week, play, ytg, air, complete=0, td=0, rec="W1", off="ARI", deff="NYG", game=None):
    return {"season": 2026, "week": week, "game_id": game or f"2026_0{week}_{off}_{deff}", "play_id": play, "season_type": "REG",
            "posteam": off, "defteam": deff, "play_type": "pass", "yardline_100": ytg, "pass_attempt": 1,
            "receiver_player_id": rec, "receiver_player_name": "M.Wilson", "receiver_player_position": "WR", "air_yards": air,
            "complete_pass": complete, "pass_touchdown": td, "touchdown": td, "td_player_id": rec if td else "",
            "fixed_drive": 1, "fixed_drive_result": "Touchdown" if td else "Field goal", "drive_inside20": int(ytg <= 20),
            "desc": "TEST ONLY"}


def _run(week, play, ytg, td=0, rb="R1", off="ARI", deff="NYG"):
    return {"season": 2026, "week": week, "game_id": f"2026_0{week}_{off}_{deff}", "play_id": play, "season_type": "REG",
            "posteam": off, "defteam": deff, "play_type": "run", "yardline_100": ytg, "rush_attempt": 1,
            "rusher_player_id": rb, "rusher_player_name": "T.Back", "rusher_player_position": "RB", "rush_touchdown": td,
            "touchdown": td, "td_player_id": rb if td else "", "fixed_drive": 2, "fixed_drive_result": "Touchdown" if td else "Punt",
            "drive_inside20": int(ytg <= 20), "desc": "TEST ONLY"}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("FG_DATA_DIR", str(tmp_path))
    raw = tmp_path / "raw"
    raw.mkdir()
    rows = [
        _pass(1, "10", 4, 2), _pass(1, "11", 4, 5),        # two incomplete goal-line targets, 0 TDs
        _pass(1, "12", 4, 5, complete=1, td=1),           # one TD catch
        _run(1, "20", 3), _run(1, "21", 1, td=1),
        {**_pass(1, "30", 4, 5), "no_play": 1},           # penalty: excluded
        {**_pass(1, "31", 2, 2), "two_point_attempt": 1},  # 2-pt: excluded
        _run(2, "40", 2, td=1, off="ARI", deff="SEA"),
    ]
    _write(raw / "pbp_2026.csv", PBP_COLS, rows)
    stats_cols = ["player_id", "player_display_name", "position", "season_type", "week", "game_id", "team", "opponent_team",
                  "carries", "targets", "receptions", "rushing_tds", "receiving_tds", "passing_tds"]
    _write(raw / "stats_2026.csv", stats_cols, [
        {"player_id": "W1", "player_display_name": "M.Wilson", "position": "WR", "season_type": "REG", "week": 1, "game_id": "2026_01_ARI_NYG",
         "team": "ARI", "opponent_team": "NYG", "targets": 3, "receptions": 1, "receiving_tds": 1},
        {"player_id": "R1", "player_display_name": "T.Back", "position": "RB", "season_type": "REG", "week": 1, "game_id": "2026_01_ARI_NYG",
         "team": "ARI", "opponent_team": "NYG", "carries": 2, "rushing_tds": 1},
        {"player_id": "Q1", "player_display_name": "Q.Back", "position": "QB", "season_type": "REG", "week": 1, "game_id": "2026_01_ARI_NYG",
         "team": "ARI", "opponent_team": "NYG", "passing_tds": 1},
    ])
    _write(raw / "roster_2026.csv", ["season", "week", "game_type", "gsis_id", "team", "position", "full_name", "status"], [
        {"season": 2026, "week": 1, "game_type": "REG", "gsis_id": "W1", "team": "ARI", "position": "WR", "full_name": "M.Wilson", "status": "ACT"},
        {"season": 2026, "week": 1, "game_type": "REG", "gsis_id": "B9", "team": "ARI", "position": "WR", "full_name": "Bench Guy", "status": "ACT"},
    ])
    from engine import db, paths

    importlib.reload(paths)
    c = db.connect(paths.db_path())
    yield c, raw
    c.close()


def _import_all(c, raw, **kw):
    from engine import ingest

    return [ingest.import_file(c, k, 2026, raw / f"{k}_2026.csv", log=lambda m: None, **kw) for k in ("pbp", "stats", "roster")]


def test_import_is_idempotent_and_build(env):
    c, raw = env
    first = _import_all(c, raw)
    assert all(r["status"] == "ok" for r in first)
    n = c.execute("SELECT COUNT(*) FROM pbp_events").fetchone()[0]
    assert n == 6  # no_play and two-point rows excluded
    second = _import_all(c, raw)
    assert all(r["status"] == "unchanged" for r in second)
    assert c.execute("SELECT COUNT(*) FROM pbp_events").fetchone()[0] == n
    forced = _import_all(c, raw, force=True)
    assert all(r["status"] == "ok" for r in forced)
    assert c.execute("SELECT COUNT(*) FROM pbp_events").fetchone()[0] == n


def test_failed_import_keeps_previous_data(env):
    c, raw = env
    _import_all(c, raw)
    (raw / "pbp_2026.csv").write_text("season,week\n2026,1\n")  # broken file: missing required columns
    from engine import ingest

    r = ingest.import_file(c, "pbp", 2026, raw / "pbp_2026.csv", log=lambda m: None)
    assert r["status"] == "error"
    assert c.execute("SELECT COUNT(*) FROM pbp_events").fetchone()[0] == 6
    assert c.execute("SELECT status FROM sources WHERE kind='pbp' AND season=2026").fetchone()[0] == "ok"


def test_goal_line_misses_are_opportunities_not_drops(env):
    c, raw = env
    _import_all(c, raw)
    from engine import aggregates

    aggregates.build_player_game(c, log=lambda m: None)
    w = dict(c.execute("SELECT * FROM player_game WHERE player_id='W1' AND week=1").fetchone())
    assert w["goal5_targets"] == 3 and w["rec_tds"] == 1
    assert w["ez_target_proxy"] == 2  # air 5 from the 4 counts; air 2 does not
    assert w["missed_rz_targets"] == 2
    assert "drops" not in w  # no drop column exists; misses are never labelled drops
    r = dict(c.execute("SELECT * FROM player_game WHERE player_id='R1' AND week=1").fetchone())
    assert r["goal5_carries"] == 2 and r["missed_goal5_carries"] == 1 and r["scored_anytime"] == 1
    q = dict(c.execute("SELECT * FROM player_game WHERE player_id='Q1'").fetchone())
    assert q["scored_anytime"] == 0  # passing TDs are not anytime TDs
    # Roster row without a box score or snaps is not a participant (and is not in player_game).
    assert c.execute("SELECT COUNT(*) FROM player_game WHERE player_id='B9'").fetchone()[0] == 0


def test_defense_splits_use_prior_games_only(env):
    c, raw = env
    _import_all(c, raw)
    from engine import aggregates, features

    aggregates.build_player_game(c, log=lambda m: None)
    aggregates.build_team_and_defense(c, log=lambda m: None)
    t2 = features.defense_table(c, 2026, 2)
    assert set(t2.defense) == {"NYG"}  # the Week 2 SEA game is not visible at the Week 2 cutoff
    nyg = t2[t2.defense == "NYG"].set_index("position")
    assert int(nyg.loc["WR", "touchdowns"]) == 1 and int(nyg.loc["RB", "touchdowns"]) == 1
    assert int(t2.games.max()) == 1
    t3 = features.defense_table(c, 2026, 3)
    assert set(t3.defense) == {"NYG", "SEA"}


def test_api_masks_uncalibrated_probability_and_locks_are_immutable(env):
    c, raw = env
    from fastapi.testclient import TestClient

    import main

    client = TestClient(main.app)
    body = client.get("/api/rankings", params={"season": 2026, "week": 2}).json()
    assert body["rows"] == [] and body["empty_reason"]
    with c:
        c.execute("INSERT INTO model_runs VALUES ('pr-x','prediction','fg-structural-1 (research rank only)','2026-01-01T00:00:00+00:00',"
                  "2026,2,'2026-09-14',NULL,'{}','{}','{}',0,0)")
        c.execute("INSERT INTO predictions VALUES ('pr-x',2026,2,'g','W1','M.Wilson','WR','ARI','SEA',1,NULL,'[]','{}',0.4,0.55,90,1,'Low',NULL,NULL)")
    body = client.get("/api/rankings", params={"season": 2026, "week": 2}).json()
    assert body["calibrated"] is False
    assert body["rows"][0]["p_model"] is None  # stored value is never exposed without validation
    with c:
        c.execute("INSERT INTO top3_locks VALUES ('lock-1','2026-01-01',2026,2,'pr-x','v',0,'2026-09-14','[]',NULL)")
    with pytest.raises(sqlite3.DatabaseError):
        c.execute("UPDATE top3_locks SET note='edit' WHERE lock_id='lock-1'")
    with pytest.raises(sqlite3.DatabaseError):
        c.execute("DELETE FROM top3_locks WHERE lock_id='lock-1'")


def test_weeks_open_on_the_last_week_with_picks_until_the_new_week_runs(env):
    c, raw = env
    _import_all(c, raw)
    from fastapi.testclient import TestClient

    import main

    client = TestClient(main.app)
    with c:
        c.execute("INSERT INTO model_runs VALUES ('pr-w2','prediction','m','2026-01-01T00:00:00+00:00',"
                  "2026,2,'2026-09-14',NULL,'{}','{}','{}',0,0)")
    body = client.get("/api/weeks").json()   # week 3 is current (week 2 played) but has no run yet
    assert body["current_week"] == 2 and body["next_week"] == 3
    with c:
        c.execute("INSERT INTO model_runs VALUES ('pr-w3','prediction','m','2026-01-02T00:00:00+00:00',"
                  "2026,3,'2026-09-21',NULL,'{}','{}','{}',0,0)")
    body = client.get("/api/weeks").json()
    assert body["current_week"] == 3 and body["next_week"] is None


def test_odds_and_wilson():
    from app.core import implied_probability
    from engine.backtest import wilson

    assert abs(implied_probability("+150", None) - 0.4) < 1e-9
    assert abs(implied_probability("-120", None) - 120 / 220) < 1e-9
    assert abs(implied_probability("2.50", "decimal") - 0.4) < 1e-9
    lo, hi = wilson(6, 8)
    assert 0.40 < lo < 0.41 and 0.92 < hi < 0.93
