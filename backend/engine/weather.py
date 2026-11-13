"""Game-day wind for outdoor NFL games, and what it does to passing and receiving props.

The prop models have no weather input, but sportsbook lines do. On the props walk-forward (2025-26 out-of-sample
projections vs nflverse's game-day wind, 2026-11-13), outdoor games with 15+ mph wind came in under projection on
passing yards by 20%, receiving yards by 25% and receptions by 21% (rushing ran 13% over). A multiplier of
1 + rate x (wind - 10 mph, at most 20 mph) fit on 2025 Weeks 1-9 and tested on Weeks 10-18: passing yards log loss
.6864 -> .6784 and 60%+ leans 62.1% -> 65.0% (140); receiving yards .6776 -> .6737; receptions .6496 -> .6465. On 2026
Weeks 1-8 (few windy games) it was flat. Rushing was mixed, and cold had too few test games, so neither is used.

Live games use the Open-Meteo hourly forecast at the home stadium for kickoff (no key needed). Domes, closed or
unknown roofs, early international kickoffs (before 10 am Eastern) and any failed lookup get no adjustment.
"""
from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

CALM_MPH = 10.0
MAX_EXCESS_MPH = 20.0
RATE = {"pass_yards": -0.020, "rec_yards": -0.025, "receptions": -0.015}
OPEN_ROOFS = {"outdoors", "open"}
FORECAST_URL = ("https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=wind_speed_10m"
                "&wind_speed_unit=mph&timezone=UTC&forecast_days=16")

# home stadiums (latitude, longitude)
STADIUMS = {
    "ARI": (33.5276, -112.2626), "ATL": (33.7554, -84.4008), "BAL": (39.2780, -76.6227), "BUF": (42.7738, -78.7870),
    "CAR": (35.2258, -80.8528), "CHI": (41.8623, -87.6167), "CIN": (39.0955, -84.5161), "CLE": (41.5061, -81.6995),
    "DAL": (32.7473, -97.0945), "DEN": (39.7439, -105.0201), "DET": (42.3400, -83.0456), "GB": (44.5013, -88.0622),
    "HOU": (29.6847, -95.4107), "IND": (39.7601, -86.1639), "JAX": (30.3239, -81.6373), "KC": (39.0489, -94.4839),
    "LV": (36.0909, -115.1833), "LAC": (33.9535, -118.3392), "LA": (33.9535, -118.3392), "MIA": (25.9580, -80.2389),
    "MIN": (44.9737, -93.2581), "NE": (42.0909, -71.2643), "NO": (29.9511, -90.0812), "NYG": (40.8135, -74.0745),
    "NYJ": (40.8135, -74.0745), "PHI": (39.9008, -75.1675), "PIT": (40.4468, -80.0158), "SF": (37.4030, -121.9700),
    "SEA": (47.5952, -122.3316), "TB": (27.9759, -82.5033), "TEN": (36.1665, -86.7713), "WAS": (38.9078, -76.8645),
}
ET = ZoneInfo("America/New_York")


def factor(market: str, wind_mph: float | None) -> float:
    """Multiplier for a market's projection at this wind (1.0 = no change)."""
    rate = RATE.get(market)
    if rate is None or wind_mph is None:
        return 1.0
    excess = min(max(float(wind_mph) - CALM_MPH, 0.0), MAX_EXCESS_MPH)
    return 1.0 + rate * excess


def kickoff_utc(gameday: str, gametime: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(f"{gameday}T{gametime or '13:00'}").replace(tzinfo=ET).astimezone(ZoneInfo("UTC"))
    except (TypeError, ValueError):
        return None


def _fetch(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read())


def forecast_wind(home: str, kickoff: datetime, fetch=_fetch) -> float | None:
    """Forecast sustained wind (mph) at the home stadium in the kickoff hour."""
    loc = STADIUMS.get(home)
    if loc is None:
        return None
    data = fetch(FORECAST_URL.format(lat=loc[0], lon=loc[1]))
    hourly = data.get("hourly") or {}
    want = kickoff.strftime("%Y-%m-%dT%H:00")
    for t, w in zip(hourly.get("time") or [], hourly.get("wind_speed_10m") or []):
        if t == want and w is not None:
            return float(w)
    return None


def game_winds(c, season: int, week: int, fetch=_fetch, log=print) -> dict[str, float]:
    """Kickoff wind for this week's outdoor games that have not been played, by game_id. Never raises."""
    if os.environ.get("FG_WEATHER", "1") == "0":
        return {}
    out = {}
    rows = c.execute("SELECT game_id, home_team, gameday, gametime, roof, home_score FROM games WHERE season=? AND week=?",
                     (season, week)).fetchall()
    for gid, home, day, tm, roof, score in rows:
        if score is not None or (roof or "").lower() not in OPEN_ROOFS or (tm or "13:00") < "10:00":
            continue
        k = kickoff_utc(day, tm)
        if k is None:
            continue
        try:
            w = forecast_wind(home, k, fetch)
        except Exception as ex:  # a missing forecast only means no adjustment
            log(f"weather: {gid} forecast failed ({ex})")
            continue
        if w is not None:
            out[gid] = w
    if out:
        log("weather: kickoff wind " + ", ".join(f"{g} {w:.0f} mph" for g, w in sorted(out.items())))
    return out
