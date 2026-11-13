import sqlite3
from datetime import datetime, timezone

from engine import weather


def test_factor():
    assert weather.factor("pass_yards", 8) == 1.0
    assert abs(weather.factor("pass_yards", 20) - 0.8) < 1e-9
    assert abs(weather.factor("rec_yards", 45) - 0.5) < 1e-9          # capped at 20 mph over calm
    assert weather.factor("rush_yards", 30) == 1.0
    assert weather.factor("receptions", None) == 1.0


def test_kickoff_is_eastern():
    assert weather.kickoff_utc("2026-11-15", "13:00") == datetime(2026, 11, 15, 18, 0, tzinfo=timezone.utc)


def _db():
    c = sqlite3.connect(":memory:")
    c.execute("CREATE TABLE games(game_id TEXT, season INT, week INT, home_team TEXT, gameday TEXT, gametime TEXT, roof TEXT, home_score INT)")
    c.executemany("INSERT INTO games VALUES (?,?,?,?,?,?,?,?)", [
        ("2026_10_MIN_GB", 2026, 10, "GB", "2026-11-15", "13:00", "outdoors", None),
        ("2026_10_CAR_NO", 2026, 10, "NO", "2026-11-15", "13:00", "dome", None),
        ("2026_10_NE_DET", 2026, 10, "DET", "2026-11-15", "09:30", "outdoors", None),   # early international kickoff
        ("2026_10_WAS_NYG", 2026, 10, "NYG", "2026-11-12", "20:15", "outdoors", 21),     # already played
        ("2026_10_KC_ATL", 2026, 10, "ATL", "2026-11-15", "13:00", "", None),            # unknown roof
    ])
    return c


def test_game_winds_only_open_unplayed_games():
    calls = []

    def fetch(url):
        calls.append(url)
        return {"hourly": {"time": ["2026-11-15T17:00", "2026-11-15T18:00"], "wind_speed_10m": [12.0, 21.5]}}

    assert weather.game_winds(_db(), 2026, 10, fetch=fetch, log=lambda *_: None) == {"2026_10_MIN_GB": 21.5}
    assert len(calls) == 1 and "latitude=44.5013" in calls[0]


def test_failed_forecast_means_no_adjustment():
    def fetch(url):
        raise OSError("offline")

    assert weather.game_winds(_db(), 2026, 10, fetch=fetch, log=lambda *_: None) == {}
