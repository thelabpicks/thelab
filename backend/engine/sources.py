"""Catalog of NFLverse release files the importer understands.

The nine files the handoff calls "required" are pbp/stats 2023-2026 plus roster for the
current season. Schedules, injuries, snap counts and prior-season rosters are enrichment:
they unlock pregame lines, availability and participation, and the app degrades
gracefully (with visible flags) when they are missing.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date

RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
LICENSE_NOTE = (
    "nflverse data is published openly by the nflverse project (nflfastR / nflreadr). "
    "Play-by-play derives from NFL Game Statistics & Information System feeds. Review the "
    "nflverse-data release notes and licence (CC-BY 4.0 for nflverse-produced data) before "
    "redistributing. Attribution: nflverse, https://github.com/nflverse/nflverse-data"
)


@dataclass(frozen=True)
class SourceKind:
    kind: str
    url_template: str
    local_template: str
    description: str
    seasonal: bool = True


KINDS: dict[str, SourceKind] = {
    "pbp": SourceKind("pbp", RELEASE_BASE + "/pbp/play_by_play_{year}.csv", "pbp_{year}.csv",
                      "Play-by-play (rush and target events, drives)"),
    "stats": SourceKind("stats", RELEASE_BASE + "/stats_player/stats_player_week_{year}.csv", "stats_{year}.csv",
                        "Weekly player box scores (including zero-TD games)"),
    "roster": SourceKind("roster", RELEASE_BASE + "/weekly_rosters/roster_weekly_{year}.csv", "roster_{year}.csv",
                         "Weekly rosters with status (ACT/INA/RES...)"),
    "injuries": SourceKind("injuries", RELEASE_BASE + "/injuries/injuries_{year}.csv", "injuries_{year}.csv",
                           "Official weekly injury reports (Out/Doubtful/Questionable)"),
    "snaps": SourceKind("snaps", RELEASE_BASE + "/snap_counts/snap_counts_{year}.csv", "snaps_{year}.csv",
                        "Offensive snap counts (participation)"),
    "ftn": SourceKind("ftn", RELEASE_BASE + "/ftn_charting/ftn_charting_{year}.csv", "ftn_{year}.csv",
                      "FTN charting: pass rushers, blitzers, box count, play action, motion, screens (schemes page)"),
    "participation": SourceKind("participation", RELEASE_BASE + "/pbp_participation/pbp_participation_{year}.csv",
                                "participation_{year}.csv", "NGS participation: man/zone and coverage shell (schemes page)"),
    "schedules": SourceKind("schedules", RELEASE_BASE + "/schedules/games.csv", "schedules.csv",
                            "Schedule, kickoff times, results and market spread/total lines", seasonal=False),
}


# How far back the engine reads. The first season only seeds xTD rates and recent-form features; models are
# trained on every later season and tested week by week from TEST_SEASONS back.
HISTORY_SEASONS = 8   # 2018 when the current season is 2026
TEST_SEASONS = 5      # walk-forward test weeks: 2021 onward (plus the current season)


def season_for(today: date | None, env: str, flip: tuple[int, int], offset: int = 0) -> int:
    """The season the site works on: `offset` + this year from the (month, day) `flip` on, last year's before it. The
    repository variable named `env` (passed to the workflows) pins a season instead."""
    pinned = (os.environ.get(env) or "").strip()
    if pinned.isdigit():
        return int(pinned)
    today = today or date.today()
    return today.year + offset - (0 if (today.month, today.day) >= flip else 1)


def current_season(today: date | None = None) -> int:
    """NFL seasons are named by the year they start. The new one takes over on September 1 (Week 1 kicks off the
    Thursday after Labor Day); until its files are posted, engine.cli keeps running the season before."""
    return season_for(today, "NFL_SEASON", (9, 1))


def history_start(season: int) -> int:
    return season - HISTORY_SEASONS


def plan(season: int = 2026, start_year: int | None = None) -> list[dict]:
    """Ordered import plan: (kind, season, required)."""
    start_year = history_start(season) if start_year is None else start_year
    out = []
    for yr in range(start_year, season + 1):
        out.append({"kind": "pbp", "season": yr, "required": True})
        out.append({"kind": "stats", "season": yr, "required": True})
    out.append({"kind": "roster", "season": season, "required": True})
    out.append({"kind": "schedules", "season": 0, "required": False})
    for yr in range(start_year + 1, season + 1):
        if yr != season:
            out.append({"kind": "roster", "season": yr, "required": False})
        out.append({"kind": "injuries", "season": yr, "required": False})
        out.append({"kind": "snaps", "season": yr, "required": False})
    return out


def url_for(kind: str, season: int) -> str:
    return KINDS[kind].url_template.format(year=season)


def local_name(kind: str, season: int) -> str:
    return KINDS[kind].local_template.format(year=season)
