"""NBA player-game history and pregame features.

Every feature for a game uses only games played before that game's date (all rolling values are shifted by one game
and same-day games never see each other). Seasons are named by the year they end (2027 = 2026-27).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import sources

STATS = {"points": "points", "rebounds": "rebounds", "assists": "assists", "threes": "three_point_field_goals_made"}
COLS = ["game_id", "season", "season_type", "game_date", "game_date_time", "athlete_id", "athlete_display_name",
        "athlete_headshot_href", "athlete_position_abbreviation", "team_abbreviation", "opponent_team_abbreviation",
        "home_away", "minutes", "starter", "did_not_play", "reason", "points", "rebounds", "offensive_rebounds", "assists",
        "three_point_field_goals_made", "three_point_field_goals_attempted", "field_goals_attempted",
        "field_goals_made", "free_throws_attempted", "turnovers", "steals", "blocks", "team_score", "opponent_team_score"]
POS = {"G": "G", "PG": "G", "SG": "G", "F": "F", "SF": "F", "PF": "F", "C": "C"}


def load_box(first: int | None = None, last: int = sources.CURRENT_SEASON) -> pd.DataFrame:
    """Every player-game row from first..last (regular season, play-in and playoffs; All-Star games dropped)."""
    frames = []
    for yr in range(first or sources.first_season(last), last + 1):
        p = sources.raw_dir() / sources.local_name("player_box", yr)
        if p.exists():
            frames.append(pd.read_csv(p, low_memory=False, usecols=lambda c: c in COLS))
    if not frames:
        raise FileNotFoundError(f"No NBA box scores in {sources.raw_dir()}; run python -m nba.collect first")
    d = pd.concat(frames, ignore_index=True)
    d = d[d.team_abbreviation.isin(sources.NBA_TEAMS) & d.opponent_team_abbreviation.isin(sources.NBA_TEAMS)]
    d = d.rename(columns={"athlete_id": "player_id", "athlete_display_name": "player_name", "team_abbreviation": "team",
                          "opponent_team_abbreviation": "opp", "three_point_field_goals_made": "threes",
                          "three_point_field_goals_attempted": "threes_att", "field_goals_attempted": "fga",
                          "field_goals_made": "fgm", "free_throws_attempted": "fta",
                          "offensive_rebounds": "oreb", "athlete_headshot_href": "headshot"})
    d["game_date"] = pd.to_datetime(d.game_date)
    d["pos"] = d.athlete_position_abbreviation.map(POS).fillna("F")
    d["home"] = (d.home_away == "home").astype(int)
    d["played"] = (~d.did_not_play.fillna(False).astype(bool)) & (d.minutes.fillna(0) > 0)
    # dressed but not used by the coach (not injured, resting or away from the team): a game of 0 minutes
    reason = d["reason"].fillna("").astype(str).str.upper() if "reason" in d else pd.Series("", index=d.index)
    d["benched"] = ~d.played & reason.str.contains("COACH")
    for c in ("minutes", "points", "rebounds", "assists", "threes", "threes_att", "fga", "fgm", "fta", "oreb", "turnovers",
              "steals", "blocks"):
        d[c] = pd.to_numeric(d[c], errors="coerce").fillna(0.0)
    d["pra"] = d.points + d.rebounds + d.assists
    d["starter"] = d.starter.fillna(False).astype(bool).astype(int)
    d = d.drop_duplicates(["game_id", "player_id"]).sort_values(["game_date", "game_id", "team", "player_id"])
    return d.reset_index(drop=True)


def team_games(d: pd.DataFrame) -> pd.DataFrame:
    """One row per team-game with possessions and what the team allowed by position."""
    p = d[d.played]
    t = p.groupby(["game_id", "game_date", "season", "team", "opp"], as_index=False).agg(
        fga=("fga", "sum"), fta=("fta", "sum"), oreb=("oreb", "sum"), tov=("turnovers", "sum"), pts=("points", "sum"))
    t["poss"] = t.fga + 0.44 * t.fta - t.oreb + t.tov
    return t


MARKETS = ("points", "rebounds", "assists", "threes", "pra")


def _asof(left: pd.DataFrame, right: pd.DataFrame, by: list[str]) -> pd.DataFrame:
    """Attach the latest right-hand values from strictly earlier dates."""
    left = left.sort_values("game_date")
    right = right.sort_values("game_date").drop_duplicates(["game_date"] + by, keep="last")
    return pd.merge_asof(left, right, on="game_date", by=by, allow_exact_matches=False)


def _ewm_prior(g: pd.core.groupby.SeriesGroupBy, halflife: float) -> pd.Series:
    return g.transform(lambda s: s.shift(1).ewm(halflife=halflife, min_periods=1).mean())


def build_features(d: pd.DataFrame) -> pd.DataFrame:
    """Pregame features for every played game (and for upcoming rows appended with played=False, minutes=0)."""
    d = d.sort_values(["player_id", "game_date", "game_id"]).reset_index(drop=True)
    p = d[d.played | d.get("upcoming", False)].copy()
    gp = p.groupby("player_id")
    for hl, tag in ((4, "s"), (12, "l")):
        p[f"min_{tag}"] = _ewm_prior(gp.minutes, hl)
        for m in ("points", "rebounds", "assists", "threes", "pra", "fga", "threes_att", "fta"):
            # per-minute rates as minutes-weighted ewm (sum of stat / sum of minutes)
            num = gp[m].transform(lambda s: s.shift(1).ewm(halflife=hl, min_periods=1).mean())
            p[f"{m}_pm_{tag}"] = num / p[f"min_{tag}"].clip(lower=1)
    # Expected minutes counting the games a healthy player sat by the coach's decision as 0. min_s and min_l are his
    # minutes when he plays, the right base for a prop (a prop on a player who sits is void), but a player benched
    # all season keeps last season's minutes in them (Memphis's Jahmai Mashack projected for 31 minutes after four
    # straight DNPs). Game simulations fill a rotation from this one. Not a model feature: the 2024-2026 walk-forward
    # showed no gain from it on played games.
    upcoming = d["upcoming"].fillna(False).astype(bool) if "upcoming" in d else False
    benched = d["benched"].fillna(False).astype(bool) if "benched" in d else False
    # A fast career average blended with this season's own, which takes over as his games this season add up (k / (k+1)):
    # last season's role fades within a few games (2025-2027 games of players who played or sat: average miss 5.17
    # minutes -> 5.00; games 2-12 of a season 5.05 -> 4.62; 2026-27 so far 6.14 -> 4.81).
    src = d[d.played | upcoming | benched]
    career = _ewm_prior(src.groupby("player_id").minutes, 2)
    this = _ewm_prior(src.groupby(["player_id", "season"]).minutes, 2)
    k = src.groupby(["player_id", "season"]).cumcount()
    w = k / (k + 1)
    p["min_exp"] = (w * this.fillna(0) + (1 - w) * career).reindex(p.index)
    p["start_rate"] = _ewm_prior(gp.starter, 5)
    p["last_min"] = gp.minutes.shift(1)
    p["games_prior"] = gp.cumcount()
    p["season_games"] = p.groupby(["player_id", "season"]).cumcount()
    p["season_min"] = p.groupby(["player_id", "season"]).minutes.transform(lambda s: s.shift(1).expanding().mean())
    p["season_starts"] = p.groupby(["player_id", "season"]).starter.transform(lambda s: s.shift(1).fillna(0).cumsum())
    p["rest"] = gp.game_date.diff().dt.days.clip(upper=7).fillna(7)
    # Same-day guard: a player has at most one game per date, so shift(1) above never sees the same day.

    # Team pace and opponent allowances, as of the day before (merge_asof with strict inequality on the date).
    t = team_games(d).sort_values(["team", "game_date"])
    t["pace"] = t.groupby("team").poss.transform(lambda s: s.ewm(halflife=10).mean())
    t["pts_for"] = t.groupby("team").pts.transform(lambda s: s.ewm(halflife=10).mean())
    played = p[p.played]
    allowed = played.groupby(["game_id", "game_date", "opp", "pos"], as_index=False)[
        ["points", "rebounds", "assists", "threes", "pra", "minutes"]].sum().sort_values(["opp", "pos", "game_date"])
    lg = played.groupby(["game_date", "pos"])[["points", "rebounds", "assists", "threes", "pra", "minutes"]].sum()
    lg = lg.groupby("pos").cumsum().reset_index()
    for m in MARKETS:
        allowed[f"opp_{m}"] = allowed.groupby(["opp", "pos"])[m].transform(lambda s: s.ewm(halflife=15).mean()) / \
            allowed.groupby(["opp", "pos"]).minutes.transform(lambda s: s.ewm(halflife=15).mean()).clip(lower=1)
        lg[f"lg_{m}"] = lg[m] / lg.minutes.clip(lower=1)
    p = p.sort_values("game_date")
    p = _asof(p, allowed[["game_date", "opp", "pos"] + [f"opp_{m}" for m in MARKETS]], ["opp", "pos"])
    p = _asof(p, lg[["game_date", "pos"] + [f"lg_{m}" for m in MARKETS]], ["pos"])
    for m in MARKETS:
        p[f"opp_{m}"] = p[f"opp_{m}"] / p[f"lg_{m}"]
    p = _asof(p, t[["game_date", "team", "pace", "pts_for"]], ["team"])
    p = _asof(p, t[["game_date", "team", "pace"]].rename(columns={"team": "opp", "pace": "opp_pace"}), ["opp"])
    p = p.drop(columns=[f"lg_{m}" for m in MARKETS])
    for m in SIMILAR_MARKETS:
        p = _similar_allowed(p, m)
    return p


# "Players like him vs this team": how players at the position with a similar per-minute rate (thirds, cut points from
# earlier seasons) did against this opponent relative to their own pregame rate, ewm over the opponent's games, shrunk
# toward 1. Walk-forward 2024-25 to 2026-27 (2026-10-29): Poisson deviance better for points (0.14%, 90% CI 0.06-0.21),
# threes (0.12%), PRA (0.13%) and assists (0.09%); rebounds unchanged, so left out.
SIMILAR_MARKETS = ("points", "assists", "threes", "pra")
SIMILAR_HALF_LIFE = 15
SIMILAR_SHRINK_GAMES = 4


def _rate_tier(p: pd.DataFrame, m: str) -> pd.Series:
    rate = p[f"{m}_pm_l"]
    tier = pd.Series(1, index=p.index)
    for season in p.season.unique():
        ref = p[p.played & (p.season < season) & rate.notna()]
        if ref.empty:  # first season on file: everyone in the middle tier (no later games leak into the cut points)
            continue
        cut = ref.groupby("pos")[f"{m}_pm_l"].quantile([1 / 3, 2 / 3]).unstack()
        cur = p.season == season
        lo, hi = p.pos[cur].map(cut[1 / 3]), p.pos[cur].map(cut[2 / 3])
        tier[cur] = np.where(rate[cur] >= hi, 2, np.where(rate[cur] >= lo, 1, 0))
    return tier


def _similar_allowed(p: pd.DataFrame, m: str) -> pd.DataFrame:
    """sim_{m}: actual / expected (own per-minute rate x minutes played) for similar players against this opponent,
    from games on earlier dates only. 1.0 = they did their usual."""
    p = p.copy()
    p["_tier"] = _rate_tier(p, m)
    played = p[p.played].assign(_act=lambda x: x[m], _exp=lambda x: (x[f"{m}_pm_l"] * x.minutes).fillna(0))
    keys = ["opp", "pos", "_tier"]
    g = played[played._exp > 0].groupby(["game_id", "game_date"] + keys, as_index=False)[["_act", "_exp"]].sum()
    g = g.sort_values("game_date")
    gg = g.groupby(keys)
    v = gg._act.transform(lambda s: s.ewm(halflife=SIMILAR_HALF_LIFE).mean()) / \
        gg._exp.transform(lambda s: s.ewm(halflife=SIMILAR_HALF_LIFE).mean()).clip(lower=0.5)
    n = gg.cumcount() + 1
    g[f"sim_{m}"] = (v * n + SIMILAR_SHRINK_GAMES) / (n + SIMILAR_SHRINK_GAMES)
    p = _asof(p, g[["game_date"] + keys + [f"sim_{m}"]], keys)
    return p.drop(columns=["_tier"])


FEATURES = ["min_s", "min_l", "start_rate", "last_min", "games_prior", "season_games", "season_min", "rest", "home",
            "pace", "opp_pace", "pts_for"]


def features_for(market: str) -> list[str]:
    own = [f"{market}_pm_s", f"{market}_pm_l"]
    shots = ["fga_pm_l", "threes_att_pm_l", "fta_pm_l"] if market in ("points", "threes", "pra") else []
    return FEATURES + own + shots + [f"opp_{market}"] + ([f"sim_{market}"] if market in SIMILAR_MARKETS else [])
