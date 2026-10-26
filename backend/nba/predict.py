"""Projections for the next slate of NBA games.

Who is projected: everyone who played for the team in its last 15 games this season (or, before a team has played,
in last season's final 15), minus players the latest injury report lists as Out. When today's ESPN rosters are saved,
they decide the team: a player who moved in the offseason is projected for his new team before he has played for it,
and a player no longer on the roster is dropped. Each market's model is fit on every
game before the slate with the same recency weights as the walk-forward, and the dispersion and over/under
calibration come from the walk-forward's most recent 12 months of out-of-sample predictions.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
from scipy import stats as st

from . import history, props, sources, teamfit

OUT_STATUSES = {"out", "injured reserve", "suspended", "out for season"}


def load_schedule(season: int = sources.CURRENT_SEASON) -> pd.DataFrame:
    p = sources.raw_dir() / sources.local_name("schedule", season)
    s = pd.read_csv(p, low_memory=False, usecols=["game_id", "game_date", "game_date_time", "home_abbreviation",
                                                   "away_abbreviation", "status_type_completed", "season_type"])
    s["game_date"] = pd.to_datetime(s.game_date)
    return s[s.home_abbreviation.isin(sources.NBA_TEAMS) & s.away_abbreviation.isin(sources.NBA_TEAMS)]


def next_slate(s: pd.DataFrame, today: str) -> pd.DataFrame:
    up = s[(s.game_date >= pd.Timestamp(today)) & (~s.status_type_completed.fillna(False).astype(bool))]
    return up[up.game_date == up.game_date.min()] if len(up) else up


def injuries() -> dict[str, dict]:
    """Normalized player name -> {status, detail, team} from the newest saved ESPN injury report."""
    files = sorted((sources.archive_dir() / "injuries").glob("*.json"))
    if not files:
        return {}
    data = json.loads(files[-1].read_text())["data"]
    out = {}
    for team in data.get("injuries", []):
        for i in team.get("injuries", []):
            name = (i.get("athlete") or {}).get("displayName")
            if name:
                out[_norm(name)] = {"status": i.get("status", ""), "detail": i.get("shortComment", ""),
                                    "team": team.get("displayName", ""), "as_of": files[-1].stem}
    # The league's own report for the same day wins: it is what the teams file, and ESPN's list can lag it.
    # "Available" clears a player ESPN still lists.
    off = sources.archive_dir() / "official_injuries" / f"{files[-1].stem}.json"
    for p in (json.loads(off.read_text()).get("players", []) if off.exists() else []):
        k = _norm(p["name"])
        if p["status"] == "Available":
            out.pop(k, None)
        else:
            out[k] = {"status": p["status"], "detail": p.get("reason", ""), "team": p.get("team") or "", "as_of": files[-1].stem}
    return out


def rosters() -> dict[int, str]:
    """ESPN athlete id -> team abbreviation from the newest saved rosters ({} when none are saved)."""
    files = sorted((sources.archive_dir() / "rosters").glob("*.json"))
    if not files:
        return {}
    teams = json.loads(files[-1].read_text()).get("teams", {})
    return {int(a["id"]): team for team, players in teams.items() for a in players if str(a.get("id", "")).isdigit()}


def _norm(s: str) -> str:
    import re  # noqa: PLC0415
    s = re.sub(r"[^a-z ]", "", s.lower().replace("-", " ").replace(".", ""))
    return " ".join(w for w in s.split() if w not in {"jr", "sr", "ii", "iii", "iv"})


def slate_rows(d: pd.DataFrame, slate: pd.DataFrame, season: int, roster: dict[int, str] | None = None) -> pd.DataFrame:
    played = d[d.played]
    roster = rosters() if roster is None else roster
    last_team = played.sort_values("game_date").groupby("player_id").team.last()
    # enough history to project: played this season or last
    active = set(played.loc[played.season >= season - 1, "player_id"])
    rows = []
    for g in slate.itertuples():
        for team, opp, home in ((g.home_abbreviation, g.away_abbreviation, 1), (g.away_abbreviation, g.home_abbreviation, 0)):
            if roster and team in set(roster.values()):
                # today's roster decides; players new to the team bring their history from their old team
                ids = [pid for pid in active if roster.get(int(pid)) == team]
            else:
                tg = played[played.team == team]
                cur = tg[tg.season == season]
                src = cur if cur.game_id.nunique() >= 1 else tg[tg.season == season - 1]
                recent = src[src.game_id.isin(src.drop_duplicates("game_id").nlargest(15, "game_date").game_id)]
                # a player who has since played for another team is not on this roster any more
                ids = [pid for pid in recent.player_id.unique() if last_team.get(pid) == team]
            info = played[played.player_id.isin(ids)].sort_values("game_date").groupby("player_id").last()
            for pid in ids:
                r = info.loc[pid]
                rows.append({"game_id": g.game_id, "game_date": g.game_date, "game_time": g.game_date_time, "season": season,
                             "player_id": pid, "player_name": r.player_name, "headshot": r.headshot, "pos": r.pos,
                             "team": team, "opp": opp, "home": home, "played": False, "upcoming": True})
    return pd.DataFrame(rows)


def project(d: pd.DataFrame, slate: pd.DataFrame, calib: dict, season: int = sources.CURRENT_SEASON, log=print,
            team_fit: dict | None = None) -> pd.DataFrame:
    """One row per player and market with mean, distribution and the usual line. `team_fit` (nba.teamfit) scales
    each team's points so its rotation adds up to what such teams actually score."""
    up = slate_rows(d, slate, season)
    if up.empty:
        return pd.DataFrame()
    inj = injuries()
    up["injury"] = up.player_name.map(lambda n: inj.get(_norm(n), {}).get("status", ""))
    up["injury_note"] = up.player_name.map(lambda n: inj.get(_norm(n), {}).get("detail", ""))
    allr = pd.concat([d, up], ignore_index=True)
    allr["upcoming"] = allr.upcoming.fillna(False).astype(bool)
    allr["played"] = allr.played.fillna(False).astype(bool)
    f = history.build_features(allr)
    out = []
    for market in props.MARKETS:
        cols = history.features_for(market)
        rows = props.model_rows(f, market)
        train = rows[rows.played]
        test = rows[~rows.played].copy()
        if test.empty:
            continue
        m = props._fit(train, cols, season)
        test["mu"] = np.clip(m.predict(test[cols]), 0.05, None)
        c = calib[market]
        n, pr = props.nb_params(test.mu.to_numpy(), props.alpha_for(test.min_l, c["alpha_bands"]))
        test["market"] = market
        test["dist"] = [{"type": "nbinom", "n": float(nn), "p": float(pp),
                         "cdf": [round(float(x), 5) for x in st.nbinom.cdf(np.arange(int(mu * 3 + 25)), nn, pp)],
                         "platt": c["platt"]} for nn, pp, mu in zip(n, pr, test.mu)]
        test["q10"] = st.nbinom.ppf(0.1, n, pr)
        test["q90"] = st.nbinom.ppf(0.9, n, pr)
        out.append(test)
        log(f"nba predict {market}: {len(test)} players")
    res = pd.concat(out, ignore_index=True)
    meta = up.set_index("player_id")[["headshot", "injury", "injury_note", "game_time", "home"]]
    res = res.join(meta, on="player_id", rsuffix="_up")
    res["out"] = res.injury.str.lower().isin(OUT_STATUSES)
    return teamfit.apply(res, team_fit or {}, log=log)
