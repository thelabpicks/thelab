"""College football data sources.

Scores and schedules (every FBS and FCS game, back to 2010): cfbfastR-data (CollegeFootballData.com data), committed to
https://github.com/sportsdataverse/cfbfastR-data and refreshed daily upstream. Closing game lines from many books
(spreads, totals and moneylines, 2006 on): the same repository's betting file. This season's lines come from the
cfbfastR play-by-play release on sportsdataverse-data until the betting file catches up. Team and player box scores
(plays, yards, turnovers; passing, rushing and receiving) are ESPN's, from the sportsdataverse-data releases. Seasons are named by the year they start (2026 = the
2026 season, bowls in January included). Today's ESPN scoreboard (with ESPN's listed spread, total and moneyline) and
sportsbook prices from The Odds API are saved by the daily collector, because nobody else archives them.
"""
from __future__ import annotations

import os
from pathlib import Path

from engine import paths
from engine.sources import season_for

REPO = "https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main"
RELEASES = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
# The new season takes over on September 1, after Week 0 and before Labor Day weekend; CFB_SEASON (a repository
# variable) pins a season instead.
CURRENT_SEASON = season_for(None, "CFB_SEASON", (9, 1))
FIRST_SEASON = 2010       # ratings need a run-in; games are scored from 2014 on
FIRST_TEST_SEASON = 2014
PROP_SEASONS = 3          # player game logs: this season and the two before
LICENSE_NOTE = ("College football scores, schedules, closing lines and player stats: cfbfastR / CollegeFootballData.com, "
                "https://github.com/sportsdataverse/cfbfastR-data. Scoreboard: ESPN public site feed. "
                "Prices: The Odds API.")

KINDS = {
    "schedule": (REPO + "/schedules/csv/cfb_schedules_{year}.csv", "cfb_schedules_{year}.csv"),
    "lines": (REPO + "/betting/csv/cfb_line_odds.csv.gz", "cfb_line_odds.csv.gz"),
    "pbp": (RELEASES + "/cfbfastR_cfb_pbp/play_by_play_{year}.parquet", "play_by_play_{year}.parquet"),
    "pbp_stats": ("", "pbp_stats_{year}.csv"),   # built by the collector from "pbp"
    "team_box": (RELEASES + "/espn_cfb_team_box/team_box_{year}.csv", "team_box_{year}.csv"),
    "player_box": (RELEASES + "/espn_cfb_player_box/player_box_{year}.csv", "player_box_{year}.csv"),
}


def data_dir() -> Path:
    return Path(os.environ.get("CFB_DATA_DIR", paths.data_dir() / "cfb")).resolve()


def raw_dir() -> Path:
    return data_dir() / "raw"


def archive_dir() -> Path:
    """Daily snapshots nobody else keeps (prices, scoreboards, the frozen picks). The hosted collector commits this
    folder to the repository's cfb-data branch so it survives between runs."""
    return Path(os.environ.get("CFB_ARCHIVE_DIR", data_dir() / "archive")).resolve()


def url_for(kind: str, season: int | None = None) -> str:
    return KINDS[kind][0].format(year=season)


def local_name(kind: str, season: int | None = None) -> str:
    return KINDS[kind][1].format(year=season)
