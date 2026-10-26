import json

import numpy as np
import pandas as pd
import pytest

from cfb import collect, model, pipeline, ratings, report


def test_budget_keeps_the_reserve_and_buys_lines_on_tuesday_and_saturday():
    tue = collect.plan_budget(480, 20, n_games=60, n_featured=3, weekday=1)
    assert tue["game_lines"] and tue["team_totals"] == 0 and tue["props"] == 0 and tue["cost"] == 3
    sat = collect.plan_budget(480, 20, n_games=60, n_featured=3, weekday=5)
    assert sat["game_lines"] and sat["team_totals"] == 3 and sat["props"] == 1 and sat["cost"] == 3 + 3 + 4
    assert not collect.plan_budget(480, 20, 60, 3, weekday=0)["game_lines"]          # Monday: nothing
    assert collect.plan_budget(480, 20, 60, 3, weekday=3)["game_lines"]              # Thursday, Tuesday missed
    assert not collect.plan_budget(480, 20, 60, 3, weekday=3, have_lines_this_week=True)["game_lines"]
    low = collect.plan_budget(202, 298, 60, 3, weekday=5)
    assert not low["game_lines"] and low["cost"] == 0
    paid = collect.plan_budget(19000, 1000, 60, 4, weekday=5)
    assert paid["plan"] == "paid" and paid["props"] == 4 and paid["alt"] == 60
    assert sat["alt"] == 0 and tue["alt"] == 0 and collect.plan_budget(19000, 1000, 60, 4, weekday=1)["alt"] == 0
    assert not collect.plan_budget(None, None, 60, 3, 5)["game_lines"]


def test_free_plan_buys_alternate_lines_only_when_asked_and_above_the_reserve(monkeypatch):
    monkeypatch.setenv("CFB_ALT_GAMES", "4")
    sat = collect.plan_budget(480, 20, n_games=60, n_featured=3, weekday=5)
    assert sat["alt"] == 3 and sat["cost"] == 3 + 3 + 4 + 3 * 2
    assert collect.plan_budget(213, 287, n_games=60, n_featured=3, weekday=5)["alt"] == 1   # 3 credits left above the reserve


def test_team_names_match_the_longest_school():
    teams = {"Miami": 1, "Miami (OH)": 2, "Texas": 3, "Texas A&M": 4}
    assert collect.match_team("Miami (OH) RedHawks", teams) == 2
    assert collect.match_team("Miami Hurricanes", teams) == 1
    assert collect.match_team("Texas A&M Aggies", teams) == 4
    assert collect.match_team("Texas Longhorns", teams) == 3
    assert collect.match_team("Oregon Ducks", teams) is None


def test_scoreboard_reads_lines_and_ranks():
    ev = {"id": "401", "date": "2026-10-24T19:30Z", "status": {"type": {"name": "STATUS_SCHEDULED"}},
          "competitions": [{"neutralSite": False, "broadcasts": [{"names": ["ABC"]}], "competitors": [
              {"homeAway": "home", "team": {"id": "333", "abbreviation": "ALA"}, "curatedRank": {"current": 4}},
              {"homeAway": "away", "team": {"id": "2", "abbreviation": "AUB"}, "curatedRank": {"current": 99}}],
              "odds": [{"provider": {"name": "ESPN BET"}, "details": "AUB -3.5", "overUnder": 51.5,
                        "homeTeamOdds": {"moneyLine": 140}, "awayTeamOdds": {"moneyLine": -165}}]}]}
    r = collect.parse_scoreboard({"data": {"events": [ev]}})[0]
    assert r["game_id"] == 401 and r["home_rank"] == 4 and r["away_rank"] is None and r["tv"] == "ABC"
    assert r["home_spread"] == 3.5 and r["total"] == 51.5 and r["ml_home"] == 140 and r["ml_away"] == -165


def _league(seed=0, n_teams=24, weeks=12):
    rng = np.random.default_rng(seed)
    off = rng.normal(0, 7, n_teams)
    de = rng.normal(0, 7, n_teams)
    rows = []
    day = pd.Timestamp("2025-09-01")
    gid = 1
    for w in range(weeks):
        order = rng.permutation(n_teams)
        for i in range(0, n_teams, 2):
            h, a = order[i], order[i + 1]
            hp = 28 + off[h] - de[a] + 1.5 + rng.normal(0, 7)
            ap = 28 + off[a] - de[h] - 1.5 + rng.normal(0, 7)
            rows.append({"game_id": gid, "date": day + pd.Timedelta(days=7 * w), "season": 2025, "week": w + 1,
                         "season_type": "regular", "home_id": h, "away_id": a, "neutral": False, "final": True,
                         "home_points": round(max(hp, 0)), "away_points": round(max(ap, 0))})
            gid += 1
    return pd.DataFrame(rows), off, de


def test_ratings_recover_team_strength():
    g, off, de = _league(weeks=20)
    r = ratings.fit(g, g.date.max() + pd.Timedelta(days=1), half_life=1e6, alpha=1.0)
    est_off = np.array([r["off"][t] for t in range(len(off))])
    est_def = np.array([r["def"][t] for t in range(len(de))])
    assert np.corrcoef(est_off, off)[0, 1] > 0.8 and np.corrcoef(est_def, de)[0, 1] > 0.8
    assert 0 < r["home"] < 4


def test_ratings_use_only_earlier_games():
    g, *_ = _league()
    cut = g.date.iloc[len(g) // 2]
    a = ratings.fit(g, cut)
    changed = g.copy()
    changed.loc[changed.date >= cut, "home_points"] += 50
    b = ratings.fit(changed, cut)
    assert a["off"] == b["off"] and a["base"] == b["base"]


def test_simulation_counts_pushes_and_chances_add_up():
    pool = np.array([[0.0, 0.0], [3.0, 0.0], [-3.0, 0.0], [7.0, -7.0], [-7.0, 7.0]])
    h, a = model.simulate(np.array([24.0]), np.array([21.0]), pool, n=5000, seed=1)
    assert h.shape == (1, 5000) and (h >= 0).all() and (h == np.rint(h)).all()
    c = model.chances(h, a, np.array([-3.0]), np.array([45.0]), np.array([23.5]), np.array([20.5]))
    margin = h - a
    assert c["push_spread"][0] == pytest.approx((margin == 3).mean())
    assert 0 < c["p_home_cover"][0] < 1 and 0 < c["p_over"][0] < 1
    assert c["p_home_win"][0] == pytest.approx((margin > 0).mean() + 0.5 * (margin == 0).mean())


def test_implied_team_total_sits_on_a_half_point():
    tt = model.implied_team_total(pd.Series([-7.0, 3.0]), pd.Series([55.0, 48.5]), "home")
    assert list(tt) == [31.5, 22.5]


def test_a_tier_counts_only_if_stronger_tiers_count():
    rows = []
    rng = np.random.default_rng(2)
    for p, rate in ((0.51, 0.50), (0.53, 0.56), (0.56, 0.50)):   # middle tier hot, top tier not
        for s in (2023, 2024, 2025):
            rows += [{"p": p, "won": int(rng.random() < rate), "season": s} for _ in range(400)]
    t = report.tier_rows(pd.DataFrame(rows), recent=[2024, 2025])
    assert [x["proven"] for x in t] == [False, False, False]
    rows = [r for r in rows if r["p"] != 0.56] + [{"p": 0.56, "won": int(rng.random() < 0.6), "season": s}
                                                     for s in (2023, 2024, 2025) for _ in range(400)]
    t = report.tier_rows(pd.DataFrame(rows), recent=[2024, 2025])
    assert t[2]["proven"] and t[1]["proven"] and not t[0]["proven"]


def test_frozen_picks_are_graded_at_their_line(tmp_path, monkeypatch):
    monkeypatch.setenv("CFB_ARCHIVE_DIR", str(tmp_path))
    (tmp_path / "picks").mkdir()
    pick = {"game_id": 9, "date": "2026-10-24T19:30:00Z", "home": "Alabama", "away": "Auburn", "line": {},
            "markets": [{"market": "spread", "side": "home", "team": "Alabama", "line": -3.5, "p": 0.55, "tier": "Strong", "proven": False},
                        {"market": "total", "side": "under", "line": 51.5, "p": 0.56, "tier": "Strong", "proven": True},
                        {"market": "team_total", "team": "Auburn", "team_side": "away", "side": "over", "line": 23.5, "p": 0.53,
                         "tier": "Lean", "proven": False, "line_posted": False},
                        {"market": "moneyline", "side": "away", "team": "Auburn", "p": 0.4, "price": 150, "tier": "Value", "proven": False}]}
    (tmp_path / "picks" / "9.json").write_text(json.dumps(pick))
    g = pd.DataFrame([{"game_id": 9, "final": True, "date": pd.Timestamp("2026-10-24T19:30:00Z"), "home_points": 24, "away_points": 21}])
    rec = pipeline.record(g, {})
    won = {r["market"]: r["won"] for r in rec["recent"]} | {r["market"]: r["rate"] for r in rec["by_market_tier"]}
    assert rec["picks"] == 4 and rec["suggested"] == {"n": 1, "hits": 1, "rate": 1.0}
    assert won["spread"] == 0.0 and won["total"] == 1 and won["team_total"] == 0.0 and won["moneyline"] == 0.0


def test_frozen_picks_keep_the_last_run_before_kickoff(tmp_path, monkeypatch):
    from datetime import datetime, timezone
    monkeypatch.setenv("CFB_ARCHIVE_DIR", str(tmp_path))

    def row(total):
        return {"game_id": 9, "date": "2026-10-24T19:30:00Z", "home": "Alabama", "away": "Auburn", "featured": False,
                "line": {"has_line": True, "total": total}, "model": {}, "markets": []}

    def saved():
        return json.loads((tmp_path / "picks" / "9.json").read_text())["line"]["total"]

    pipeline.freeze([row(50.5)], datetime(2026, 10, 23, 15, tzinfo=timezone.utc))   # Friday's run
    pipeline.freeze([row(52.5)], datetime(2026, 10, 24, 15, tzinfo=timezone.utc))   # Saturday's run, new lines
    assert saved() == 52.5
    pipeline.freeze([row(55.5)], datetime(2026, 10, 24, 20, tzinfo=timezone.utc))   # after kickoff: untouched
    assert saved() == 52.5


def test_qb_change_flags_a_new_passer_in_the_last_game():
    rows = [(g, "Starter", 30) for g in (1, 2, 3)] + [(4, "Backup", 28), (4, "Starter", 3)]
    pg = pd.DataFrame([{"season": 2026, "team_id": 9, "game_id": g, "athlete_name": n, "pass_att": a, "rush_att": 3} for g, n, a in rows])
    assert pipeline.qb_changes(pg, 2026) == {9: {"season_leader": "Starter", "last_game": "Backup"}}
    assert pipeline.qb_changes(pg[pg.game_id < 4], 2026) == {}


def test_qb_change_catches_an_option_quarterback_who_barely_throws():
    # Air Force 2026: Szarka hurt, Medders started and threw 3 times
    rows = [(1, "Szarka", 11, 25), (1, "Medders", 1, 5), (2, "Szarka", 5, 13), (3, "Szarka", 10, 21), (4, "Medders", 3, 18)]
    pg = pd.DataFrame([{"season": 2026, "team_id": 2005, "game_id": g, "athlete_name": n, "pass_att": a, "rush_att": r} for g, n, a, r in rows])
    assert pipeline.qb_changes(pg, 2026) == {2005: {"season_leader": "Szarka", "last_game": "Medders"}}


def test_postgame_resim_scores_more_for_the_offense_that_played_better():
    rng = np.random.default_rng(3)
    n = 1200
    d = pd.DataFrame({f"{s}_{k}": rng.normal(m, sd, n) for s in ("home", "away")
                      for k, m, sd in (("ypp", 5.8, 1.2), ("plays", 70, 8), ("to", 1.5, 1.0),
                                       ("epa", 0.05, 0.15), ("sr", 0.42, 0.06), ("expl", 0.07, 0.03))})
    for s in ("home", "away"):
        d[f"{s}_points"] = (d[f"{s}_ypp"] * d[f"{s}_plays"] / 14 + 40 * d[f"{s}_epa"] - 3 * d[f"{s}_to"]).round()
    d["final"] = True
    d["date"] = pd.Timestamp("2026-09-01") - pd.to_timedelta(np.arange(n) % 700, unit="D")
    box = model.fit_box(d, pd.Timestamp("2026-10-01"))
    game = d.head(1).copy()
    game[["home_ypp", "home_epa", "home_to"]] = [7.5, 0.35, 0]
    game[["away_ypp", "away_epa", "away_to"]] = [4.0, -0.25, 3]
    pool = np.zeros((10, 2))
    out = model.postgame(box, game, pool)
    assert out.post_margin.iloc[0] > 20 and abs(out.post_total.iloc[0] - (out.post_home + out.post_away).iloc[0]) < 1e-9


def test_rating_ranks_bigger_kept_edges_higher_and_caps_unproven():
    from cfb import rating
    rng = np.random.default_rng(5)
    n = 4000
    p = rng.uniform(0.5, 0.6, n)
    L = pd.DataFrame({"p": p, "won": (rng.uniform(size=n) < 0.5 + 0.5 * (p - 0.5)).astype(int), "season": rng.integers(2018, 2026, n),
                      "market": "total", "dec": rating.DEC110, "q": 0.5})
    L["ret"] = L.won * L.dec - 1
    r = rating.fit(L)
    lo, hi = rating.rate(r, "total", 0.51, None), rating.rate(r, "total", 0.59, None)
    assert hi["rating"] > lo["rating"] and hi["fair_p"] < 0.59          # calibrated toward what really happened
    m = {"market": "total", "p": 0.59, "proven": False}
    assert pipeline.score_lean(m, r)["score"] <= pipeline.UNPROVEN_CAP
    assert not rating.walk_forward(L).empty


def test_book_table_groups_each_books_lines():
    offers = [{"game_id": 1, "book": "fanduel", "market": "spreads", "side": "home", "point": -3.5, "price": -112},
              {"game_id": 1, "book": "fanduel", "market": "h2h", "side": "away", "point": None, "price": 150},
              {"game_id": 1, "book": "draftkings", "market": "totals", "side": "over", "point": 55.5, "price": -110}]
    t = pipeline.book_table(offers)
    assert [b["book"] for b in t] == ["draftkings", "fanduel"]
    assert t[1]["spread"]["home"] == [-3.5, -112] and t[1]["ml"]["away"] == [None, 150] and t[0]["total"]["over"] == [55.5, -110]
    assert pipeline._hours("2026-10-20T15:00:00Z", "2026-10-22T15:00:00+00:00") == 48


def test_scoreboard_falls_back_to_one_day_at_a_time(monkeypatch):
    from datetime import datetime
    calls = []

    def fake(url, params=None):
        calls.append(params["dates"])
        if "-" in params["dates"]:
            raise RuntimeError("HTTP Error 400: Bad Request")
        return {"events": [{"id": "1"}, {"id": params["dates"]}]}, {}
    monkeypatch.setattr(collect, "_get_json", fake)
    data, params = collect._scoreboard(datetime(2026, 10, 23), log=lambda *_: None)
    assert len(calls) == 9 and params["dates"] == "by day"
    assert len(data["events"]) == 9        # game "1" listed every day is kept once


def test_rating_calibrates_moneyline_dogs_and_favorites_apart():
    from cfb import rating
    rng = np.random.default_rng(7)
    n = 6000
    dec = np.where(rng.uniform(size=n) < 0.5, 3.0, 1.5)
    q = 1 / dec
    p = q + rng.uniform(0, 0.08, n)
    # the edge held on dogs and was empty on favorites
    won = (rng.uniform(size=n) < np.where(dec > 2, p, q)).astype(int)
    L = pd.DataFrame({"p": p, "won": won, "season": rng.integers(2018, 2026, n), "market": "moneyline", "dec": dec, "q": q})
    L["ret"] = L.won * L.dec - 1
    L["cal"] = [rating.cal_key(m, d) for m, d in zip(L.market, L.dec)]
    r = rating.fit(L)
    assert set(r["cal"]) == {"moneyline_dog", "moneyline_fav"}
    dog, fav = rating.rate(r, "moneyline", 1 / 3 + 0.06, 3.0, 1 / 3), rating.rate(r, "moneyline", 2 / 3 + 0.06, 1.5, 2 / 3)
    assert dog["ev"] > 0.08 and abs(fav["ev"]) < 0.05


def test_report_card_explains_upsets(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv("CFB_ARCHIVE_DIR", str(tmp_path))
    (tmp_path / "picks").mkdir()
    snap = {"game_id": 9, "date": "2026-10-24T19:30:00Z", "home": "Navy", "away": "North Texas", "line": {"spread": 2.5, "total": 60},
            "model": {"margin": -0.6, "total": 63, "home_win": 0.497}, "ratings": {},
            "markets": [{"market": "moneyline", "side": "home", "team": "Navy", "score": 7.5}], "props": []}
    (tmp_path / "picks" / "9.json").write_text(json.dumps(snap))
    g = pd.DataFrame([{"game_id": 9, "final": True, "home_points": 28, "away_points": 24, "home_to": 0, "away_to": 2,
                       "home_epa": 0.10, "away_epa": 0.20, "home_sr": 0.50, "away_sr": 0.40, "home_expl": 0.05, "away_expl": 0.10}])
    u = pipeline.report_card(g, pd.DataFrame())["upsets"][0]
    assert u["dog"] == "Navy" and u["rated"] == 7.5 and u["model_edge"] == 1.9
    assert u["edges"]["Won the turnover battle"] == 2 and u["edges"]["Better EPA per play"] < 0


def test_upset_drivers_counts_how_often_the_dog_was_ahead():
    from cfb import report
    g = pd.DataFrame({"final": True, "spread": [7.0] * 60 + [-7.0] * 60, "margin": [3] * 60 + [10] * 60,
                      "home_to": [0] * 60 + [1] * 60, "away_to": [2] * 60 + [1] * 60})
    d = report.upset_drivers(g)
    assert d["upsets"] == 60 and d["rows"][0]["upsets"] == 1.0 and d["rows"][0]["others"] == 0.0


def test_this_week_keeps_only_the_current_week():
    now = pd.Timestamp("2026-10-24 15:00")
    g = pd.DataFrame({"game_id": [1, 2, 3, 4], "season": 2026, "season_type": "regular", "week": [8, 8, 9, 7],
                      "final": [False, False, False, True],
                      "date": pd.to_datetime(["2026-10-24 19:30", "2026-10-27 23:00", "2026-10-31 04:00", "2026-10-18 19:00"]),
                      "home_team": ["Minnesota", "WKU", "Iowa", "Iowa"], "away_team": ["Iowa", "Delaware", "Wisconsin", "X"]})
    assert g[pipeline.this_week(g, now)].game_id.tolist() == [1, 2]     # next Saturday's Wisconsin at Iowa waits a week


def test_cross_checks_flag_a_team_twice_and_a_wrong_matchup():
    g = pd.DataFrame({"season": [2026], "final": [True], "fbs_game": [True], "spread": [-3.0]})
    rows = [{"game_id": 1, "home": "Minnesota", "away": "Iowa", "home_id": 135, "away_id": 2294, "line": {"has_line": True}},
            {"game_id": 2, "home": "Iowa", "away": "Wisconsin", "home_id": 2294, "away_id": 275, "line": {"has_line": True}}]
    lines = {1: {"espn_home_id": 135, "espn_away_id": 2294}, 2: {"espn_home_id": 275, "espn_away_id": 2294}}
    c = {x["check"]: x for x in pipeline.cross_checks(g, lines, rows, pd.Series(dtype=bool))}
    assert c["Teams listed in more than one game this week"]["value"] == "Iowa"
    m = c["Matchups (home and away team) that match ESPN's schedule"]
    assert m["value"] == "1 of 2" and m["games"] == [2] and not m["ok"]


def test_odds_feed_listed_the_other_way_round_still_prices_the_right_team(monkeypatch):
    from datetime import datetime, timezone
    week = [{"game_id": 7, "home_team": "Iowa", "home_id": 2294, "away_team": "Wisconsin", "away_id": 275}]

    def fake(url, params=None):
        if url.endswith("/events"):
            return [{"id": "e", "home_team": "Wisconsin Badgers", "away_team": "Iowa Hawkeyes", "commence_time": "x"}], {"x-requests-remaining": "400", "x-requests-used": "100"}
        return [{"id": "e", "bookmakers": [{"key": "dk", "markets": [{"key": "spreads", "outcomes": [
            {"name": "Iowa Hawkeyes", "point": -4.5, "price": -110}, {"name": "Wisconsin Badgers", "point": 4.5, "price": -110}]}]}]}], {}
    monkeypatch.setattr(collect, "_get_json", fake)
    out = collect.fetch_odds("2026-10-27", "k", week, [], log=lambda *_: None, mode="never",
                             now=datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    home = [l for l in out["game_lines"] if l["side"] == "home"]
    assert out["games"][0]["flipped"] and home[0]["point"] == -4.5      # Iowa is the home team on the schedule


def test_alternate_lines_are_priced_by_the_sims_at_the_best_price():
    rng = np.random.default_rng(0)
    margin = rng.normal(14, 10, 5000).round()   # home by about two touchdowns
    pts = rng.normal(50, 12, 5000).round()
    calib = {"spread": [{"lo": 0.8, "hi": 0.85, "n": 900, "rate": 0.82, "recent_rate": 0.81},
                        {"lo": 0.85, "hi": 1.0, "n": 300, "rate": 0.84, "recent_rate": 0.84}]}
    offers = [{"market": "spreads", "side": "home", "point": -3.5, "price": -400, "book": "draftkings"},
              {"market": "spreads", "side": "home", "point": -3.5, "price": -350, "book": "fanduel"},
              {"market": "spreads", "side": "away", "point": 3.5, "price": 280, "book": "fanduel"},
              {"market": "spreads", "side": "home", "point": 10.5, "price": -5000, "book": "fanduel"},
              {"market": "totals", "side": "over", "point": 35.5, "price": -450, "book": "betmgm"}]
    rows = pipeline.alt_rows(offers, margin, pts, calib)
    home = next(r for r in rows if r["market"] == "spread")
    assert home["side"] == "home" and home["price"] == -350 and home["book"] == "fanduel"
    assert abs(home["chance"] - (margin > 3.5).mean() / ((margin > 3.5).mean() + (margin < 3.5).mean())) < 1e-9
    assert home["tested_rate"] == 0.84 and abs(home["implied"] - 350 / 450) < 1e-9
    assert not any(r["side"] == "away" for r in rows)                  # 14% chance: dropped
    assert not any(r["price"] == -5000 for r in rows)                  # priced past -1000: dropped
    assert any(r["market"] == "total" and r["side"] == "over" and r["tested_rate"] is None for r in rows)
    assert [r["chance"] for r in rows] == sorted((r["chance"] for r in rows), reverse=True)


def test_calibration_never_claims_more_edge_than_the_simulation():
    from cfb import rating
    r = {"cal": {"moneyline_dog": [[0.02, 0.05, 0.2], [-0.29, 0.02, 0.65]]}, "ref": [0.0]}
    assert rating.calibrated(r, "moneyline_dog", 0.31, 0.30) == 0.30          # edge below the fitted range: market's chance
    assert rating.calibrated(r, "moneyline_dog", 0.25, 0.30) == 0.25          # negative edge kept as the sim has it
    assert rating.calibrated(r, "moneyline_dog", 0.50, 0.30) <= 0.50          # never above the sim


def test_recent_finals_cover_games_without_site_picks():
    d = pd.to_datetime(["2026-09-01", "2026-10-17", "2026-10-24"], utc=True)
    fin = pd.DataFrame({"game_id": [1, 2, 3], "date": d, "home_points": [10, 21, 35], "away_points": [7, 24, 14]}).set_index("game_id")
    assert pipeline.recent_finals(fin) == {"2": [21.0, 24.0], "3": [35.0, 14.0]}
    assert pipeline.recent_finals(fin.iloc[:0]) == {}


def test_previous_weeks_grades_every_market_at_its_line():
    from cfb import pipeline
    hp, ap = 31.0, 24.0   # home by 7, 55 points
    g = pipeline._grade
    assert g({"market": "spread", "side": "home", "line": -6.5}, hp, ap)["result"] == "won"
    assert g({"market": "spread", "side": "away", "line": 7.0}, hp, ap)["result"] == "push"
    assert g({"market": "total", "side": "under", "line": 52.5}, hp, ap)["result"] == "lost"
    assert g({"market": "team_total", "side": "over", "team_side": "away", "line": 23.5}, hp, ap)["result"] == "won"
    assert g({"market": "moneyline", "side": "away"}, hp, ap)["result"] == "lost"
