from datetime import date

from engine import cli, sources


def test_each_sport_rolls_over_to_the_new_season_by_date(monkeypatch):
    for v in ("NFL_SEASON", "NBA_SEASON", "CFB_SEASON"):
        monkeypatch.delenv(v, raising=False)
    assert sources.current_season(date(2026, 10, 29)) == 2026
    assert sources.current_season(date(2027, 2, 10)) == 2026      # Super Bowl still belongs to 2026
    assert sources.current_season(date(2027, 9, 1)) == 2027
    nba = lambda d: sources.season_for(d, "NBA_SEASON", (10, 25), offset=1)  # noqa: E731
    assert nba(date(2026, 10, 29)) == 2027 and nba(date(2027, 6, 15)) == 2027 and nba(date(2027, 10, 25)) == 2028
    cfb = lambda d: sources.season_for(d, "CFB_SEASON", (9, 1))  # noqa: E731
    assert cfb(date(2027, 1, 10)) == 2026 and cfb(date(2027, 9, 1)) == 2027


def test_a_repository_variable_pins_the_season(monkeypatch):
    monkeypatch.setenv("NFL_SEASON", "2025")
    assert sources.current_season(date(2026, 10, 29)) == 2025
    monkeypatch.setenv("NFL_SEASON", "")
    assert sources.current_season(date(2026, 10, 29)) == 2026


def test_falls_back_only_when_just_the_new_seasons_files_are_missing():
    miss = RuntimeError("Required source files missing or invalid: pbp 2027 (missing), stats 2027 (missing), roster 2027 (error)")
    assert cli.new_season_not_posted(miss, 2027)
    old = RuntimeError("Required source files missing or invalid: pbp 2027 (missing), pbp 2024 (error)")
    assert not cli.new_season_not_posted(old, 2027)
    assert not cli.new_season_not_posted(RuntimeError("model failed"), 2027)

