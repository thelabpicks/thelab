"""NBA data sources.

Box scores and schedules come from the sportsdataverse-data releases (hoopR / ESPN), published openly and
refreshed daily: https://github.com/sportsdataverse/sportsdataverse-data. Seasons are named by the year they end
(2027 = the 2026-27 season). Injury reports and the day's scoreboard come from ESPN's public site feed; neither is
archived anywhere, so the daily collector saves a copy of each day.
"""
from __future__ import annotations

import os
from pathlib import Path

from engine import paths
from engine.sources import season_for

RELEASE_BASE = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
# Seasons are named by the year they end; the new one takes over on October 25, a few days after opening night, once
# its box score file is posted. The NBA_SEASON repository variable pins a season instead.
CURRENT_SEASON = season_for(None, "NBA_SEASON", (10, 25), offset=1)
HISTORY_SEASONS = 8     # 2018-19 onward; older seasons seed form only and are weighted far less
LICENSE_NOTE = ("NBA box scores and schedules: sportsdataverse / hoopR (ESPN data), "
                "https://github.com/sportsdataverse/sportsdataverse-data. Injuries and scoreboard: ESPN public site feed.")

KINDS = {
    "player_box": (RELEASE_BASE + "/espn_nba_player_boxscores/player_box_{year}.csv", "player_box_{year}.csv"),
    "schedule": (RELEASE_BASE + "/espn_nba_schedules/nba_schedule_{year}.csv", "nba_schedule_{year}.csv"),
}

# The Odds API full names -> ESPN abbreviations used in the box scores.
TEAMS = {"Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN", "Charlotte Hornets": "CHA",
         "Chicago Bulls": "CHI", "Cleveland Cavaliers": "CLE", "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN",
         "Detroit Pistons": "DET", "Golden State Warriors": "GS", "Houston Rockets": "HOU", "Indiana Pacers": "IND",
         "Los Angeles Clippers": "LAC", "LA Clippers": "LAC", "Los Angeles Lakers": "LAL", "Memphis Grizzlies": "MEM",
         "Miami Heat": "MIA", "Milwaukee Bucks": "MIL", "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NO",
         "New York Knicks": "NY", "Oklahoma City Thunder": "OKC", "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI",
         "Phoenix Suns": "PHX", "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC", "San Antonio Spurs": "SA",
         "Toronto Raptors": "TOR", "Utah Jazz": "UTAH", "Washington Wizards": "WSH"}
NBA_TEAMS = frozenset(TEAMS.values())


def first_season(season: int = CURRENT_SEASON) -> int:
    return season - HISTORY_SEASONS


def data_dir() -> Path:
    return Path(os.environ.get("NBA_DATA_DIR", paths.data_dir() / "nba")).resolve()


def raw_dir() -> Path:
    return data_dir() / "raw"


def archive_dir() -> Path:
    """Daily snapshots nobody else keeps (prices, injuries, scoreboards). The hosted collector commits this folder to
    the repository's nba-data branch so it survives between runs."""
    return Path(os.environ.get("NBA_ARCHIVE_DIR", data_dir() / "archive")).resolve()


def url_for(kind: str, season: int) -> str:
    return KINDS[kind][0].format(year=season)


def local_name(kind: str, season: int) -> str:
    return KINDS[kind][1].format(year=season)
