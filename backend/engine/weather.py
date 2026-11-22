"""Game-day wind and cold for outdoor NFL games, and what they do to passing and receiving props.

The prop models have no weather input, but sportsbook lines do. On the props walk-forward (2025-26 out-of-sample
projections vs nflverse's game-day wind, 2026-11-13), outdoor games with 15+ mph wind came in under projection on
passing yards by 20%, receiving yards by 25% and receptions by 21% (rushing ran 13% over). A multiplier of
1 + rate x (wind - 10 mph, at most 20 mph) fit on 2025 Weeks 1-9 and tested on Weeks 10-18: passing yards log loss
.6864 -> .6784 and 60%+ leans 62.1% -> 65.0% (140); receiving yards .6776 -> .6737; receptions .6496 -> .6465. On 2026
Weeks 1-8 (few windy games) it was flat. Rushing was mixed, so it is not adjusted.

Cold (2026-11-22): outdoor kickoffs under 40 F, on top of the wind term, measured against each player's previous-8-game
average in nflverse 2021-26. Late-season (Week 12+) cold games ran 8-9% under that average vs other late-season games
in every one of five seasons. A flat cold factor fit walk-forward on prior seasons cut the error on cold games in all
nine season-market tests (2023-25): passing yards MAE 57.9 -> 56.7, 60.5 -> 59.6, 52.1 -> 50.0; receiving yards
23.7 -> 22.9, 23.2 -> 22.7, 22.8 -> 22.2; receptions 1.59 -> 1.54, 1.52 -> 1.50, 1.44 -> 1.40. Fit through 2025:
passing yards -5%, receiving yards -5.5%, receptions -4%.

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
COLD_F = 40.0
COLD = {"pass_yards": -0.050, "rec_yards": -0.055, "receptions": -0.040}
OPEN_ROOFS = {"outdoors", "open"}
FORECAST_URL = ("https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=wind_speed_10m,temperature_2m"
                "&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC&forecast_days=16")

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


def factor(market: str, wind_mph: float | None, temp_f: float | None = None) -> float:
    """Multiplier for a market's projection at this wind and temperature (1.0 = no change)."""
    rate = RATE.get(market)
    if rate is None:
        return 1.0
    f = 1.0
    if wind_mph is not None:
        f += rate * min(max(float(wind_mph) - CALM_MPH, 0.0), MAX_EXCESS_MPH)
    if temp_f is not None and float(temp_f) < COLD_F:
        f += COLD[market]
    return f


def kickoff_utc(gameday: str, gametime: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(f"{gameday}T{gametime or '13:00'}").replace(tzinfo=ET).astimezone(ZoneInfo("UTC"))
    except (TypeError, ValueError):
        return None


def _fetch(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read())


def forecast(home: str, kickoff: datetime, fetch=_fetch) -> tuple[float | None, float | None] | None:
    """Forecast sustained wind (mph) and temperature (F) at the home stadium in the kickoff hour."""
    loc = STADIUMS.get(home)
    if loc is None:
        return None
    data = fetch(FORECAST_URL.format(lat=loc[0], lon=loc[1]))
    hourly = data.get("hourly") or {}
    want = kickoff.strftime("%Y-%m-%dT%H:00")
    times = hourly.get("time") or []
    if want not in times:
        return None
    i = times.index(want)

    def at(key):
        vals = hourly.get(key) or []
        return float(vals[i]) if i < len(vals) and vals[i] is not None else None

    wind, temp = at("wind_speed_10m"), at("temperature_2m")
    return None if wind is None and temp is None else (wind, temp)


def game_weather(c, season: int, week: int, fetch=_fetch, log=print) -> dict[str, tuple[float | None, float | None]]:
    """Kickoff (wind mph, temperature F) for this week's outdoor games that have not been played, by game_id.
    Never raises."""
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
            w = forecast(home, k, fetch)
        except Exception as ex:  # a missing forecast only means no adjustment
            log(f"weather: {gid} forecast failed ({ex})")
            continue
        if w is not None:
            out[gid] = w
    if out:
        def show(w):
            wind, temp = w
            return f"{'?' if wind is None else f'{wind:.0f}'} mph, {'?' if temp is None else f'{temp:.0f}'} F"
        log("weather: kickoff " + ", ".join(f"{g} {show(w)}" for g, w in sorted(out.items())))
    return out
