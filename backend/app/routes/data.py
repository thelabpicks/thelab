from __future__ import annotations

import os
import sqlite3

from fastapi import APIRouter, Depends, Header, HTTPException

from engine import paths, sources, status

from .. import jobs
from ..core import default_season_week, get_db, latest_walk_forward
from ..schemas import Health, RefreshRequest

router = APIRouter(prefix="/api", tags=["data"])


@router.get("/health", response_model=Health)
def health(c: sqlite3.Connection = Depends(get_db)):
    st = status.read_build_status() or {}
    wf = latest_walk_forward(c)
    return Health(status="ok", engine_version=paths.ENGINE_VERSION, data_loaded=bool(st.get("data_loaded")),
                  ready=bool(st.get("ready")), calibrated=bool(wf and wf["promoted"]))


@router.get("/data/status")
def data_status(c: sqlite3.Connection = Depends(get_db)):
    """build_status.json plus live source rows. `ready:false` until every required file and gate passes."""
    st = status.read_build_status()
    live_sources = status.source_rows(c, (st or {}).get("season") or 2026)
    if st is None:
        s, w = default_season_week(c)
        return {"ready": False, "data_loaded": False, "build_status_present": False, "season": s, "prediction_week": w,
                "sources": live_sources, "gates": [], "license": sources.LICENSE_NOTE,
                "message": "No build_status.json yet. Load the nine nflverse CSVs from the Data page or the CLI."}
    st["build_status_present"] = True
    st["sources"] = live_sources
    st["build_status_path"] = str(paths.results_dir() / "build_status.json")
    return st


def _check_admin(token: str | None):
    expected = os.environ.get("FG_ADMIN_TOKEN")
    if expected and token != expected:
        raise HTTPException(401, "Refresh requires the admin token (FG_ADMIN_TOKEN) when the server is shared.")


@router.post("/data/refresh", status_code=202)
def refresh(req: RefreshRequest, x_admin_token: str | None = Header(default=None)):
    _check_admin(x_admin_token)
    return jobs.start(req.season, req.download, req.force)


@router.get("/data/jobs")
def list_jobs(c: sqlite3.Connection = Depends(get_db)):
    return [dict(r) | {"log": None} for r in c.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 20")]


@router.get("/data/jobs/{job_id}")
def get_job(job_id: str, c: sqlite3.Connection = Depends(get_db)):
    r = c.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    if not r:
        raise HTTPException(404, "job not found")
    return dict(r)


@router.get("/weeks")
def weeks(season: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    s, cur = default_season_week(c)
    season = season or s
    seasons = [r[0] for r in c.execute("SELECT DISTINCT season FROM model_runs WHERE kind='prediction' ORDER BY season DESC")]
    rows = c.execute("""SELECT week, COUNT(*) AS games, SUM(home_score IS NOT NULL) AS completed, MIN(gameday) AS first_day,
                        MAX(gameday) AS last_day FROM games WHERE season=? GROUP BY week ORDER BY week""", (season,)).fetchall()
    runs = {r[0]: r[1] for r in c.execute("SELECT week, MAX(created_at) FROM model_runs WHERE kind='prediction' AND season=? GROUP BY week", (season,))}
    # Between weeks (Tuesday until rosters post) the new week has no run yet: open the site on the last week that has one
    # and name the next week, so no page asks for data that is not there.
    cur_runs = runs if season == s else {r[0] for r in c.execute(
        "SELECT DISTINCT week FROM model_runs WHERE kind='prediction' AND season=?", (s,))}
    shown = cur if cur in cur_runs or not any(w <= cur for w in cur_runs) else max(w for w in cur_runs if w <= cur)
    return {"season": season, "seasons": seasons or [season], "current_season": s, "current_week": shown,
            "next_week": cur if shown != cur else None,
            "weeks": [dict(r) | {"has_predictions": r["week"] in runs, "status": "completed" if r["completed"] == r["games"] else
                                 ("in_progress" if r["completed"] else "upcoming")} for r in rows]}
