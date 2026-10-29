"""Command-line worker. The API launches this as a subprocess; you can also run it directly.

  python -m engine.cli all --download      # fetch nflverse CSVs, import, build, validate, predict
  python -m engine.cli all                 # offline: use CSVs already in data/raw
  python -m engine.cli sync|build|backtest|predict|status
  python -m engine.cli smoke-test          # parser invariants (no data needed)
"""
from __future__ import annotations

import argparse
import json
import sys

from . import db, paths, pipeline, sources, status


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="engine.cli")
    ap.add_argument("command", choices=["all", "sync", "build", "backtest", "predict", "props", "correlation", "status", "smoke-test"])
    ap.add_argument("--season", type=int, help="default: the current season by date (engine.sources.current_season)")
    ap.add_argument("--week", type=int, help="predict a single week (default: all weeks of the season)")
    ap.add_argument("--download", action="store_true", help="download missing nflverse CSVs into data/raw")
    ap.add_argument("--force", action="store_true", help="re-download / re-import even if unchanged")
    a = ap.parse_args(argv)

    def log(m):
        print(m, flush=True)

    if a.command == "smoke-test":
        from tests.test_parser import run_all as smoke  # noqa: PLC0415
        smoke()
        print("PASS: parser invariants (scoring, end-zone proxy, exclusions, embargo)")
        return 0
    auto = a.season is None
    a.season = a.season or sources.current_season()
    if a.command == "all":
        try:
            pipeline.run_all(a.season, a.download, a.force, log=log)
            return 0
        except Exception as ex:  # noqa: BLE001 - message already logged and written to build_status.json
            if not (auto and new_season_not_posted(ex, a.season)):
                return 2
        # September, before the new season's files are posted: keep last season's pages up to date instead
        log(f"Season {a.season} is not posted yet; running {a.season - 1}")
        try:
            pipeline.run_all(a.season - 1, a.download, a.force, log=log)
            return 0
        except Exception:  # noqa: BLE001
            return 2
    c = db.connect(paths.db_path())
    try:
        if a.command == "sync":
            pipeline.run_sync(c, a.season, a.download, a.force, log)
        elif a.command == "build":
            pipeline.run_build(c, a.season, log)
        elif a.command == "backtest":
            r = pipeline.run_backtest(c, a.season, log)
            print(json.dumps({"run_id": r["run_id"], "promoted": r["gate"]["promoted"]}, indent=2))
        elif a.command == "predict":
            weeks = [(a.season, a.week)] if a.week else None
            for r in pipeline.run_predict(c, a.season, weeks, log):
                print(r)
        elif a.command == "correlation":
            from . import correlation  # noqa: PLC0415
            r = correlation.run(c, log)
            print(json.dumps({"run_id": r["run_id"], "used": r["use_correlation"], "gate": r["validation"]["gate"]}, indent=2))
        elif a.command == "props":
            print(json.dumps(pipeline.run_props(c, a.season, log), indent=2, default=str))
        st = status.write_build_status(c, a.season)
        if a.command == "status":
            print(json.dumps({k: v for k, v in st.items() if k not in ("sources",)}, indent=2, default=str))
        return 0
    except Exception as ex:  # noqa: BLE001
        status.write_build_status(c, a.season, error=str(ex))
        print(f"ERROR: {ex}", file=sys.stderr)
        return 2
    finally:
        c.close()


def new_season_not_posted(ex: Exception, season: int) -> bool:
    """True when the run stopped only because this season's required nflverse files are not out yet."""
    msg = str(ex)
    return msg.startswith("Required source files missing") and all(
        part.strip().split(" ")[1] == str(season) for part in msg.split(":", 1)[1].split(","))


if __name__ == "__main__":
    sys.exit(main())
