import json

from nba import collect, pipeline


def _sb(home, away, total, spread):
    return {"competitions": [{"competitors": [{"homeAway": "home", "team": {"abbreviation": home}},
                                              {"homeAway": "away", "team": {"abbreviation": away}}],
                              "odds": [{"overUnder": total, "spread": spread}]}]}


def test_espn_scoreboard_gives_free_game_lines():
    sb = {"data": {"events": [_sb("MIL", "IND", 238.5, 4.5), {"competitions": [{"competitors": [], "odds": None}]}]}}
    assert collect.espn_lines(sb) == {("MIL", "IND"): {"total": 238.5, "home_spread": 4.5}}
    assert collect.espn_lines(None) == {}


def test_game_lines_are_not_bought_when_espn_has_them():
    paid_lines = collect.plan_budget(318, 182, n_games=7)
    assert paid_lines["game_lines"] and paid_lines["cost"] == 2
    free = collect.plan_budget(318, 182, n_games=7, espn_lines=True)
    assert not free["game_lines"] and free["cost"] == 0 and free["reason"].startswith("free plan")


def test_props_bought_for_the_likeliest_picks_within_cap_and_reserve():
    wants = [("MIA", "DAL", "threes"), ("MIA", "DAL", "threes"), ("DEN", "GS", "threes"), ("UTAH", "MEM", "rebounds"), ("X", "Y", "points")]
    assert collect.plan_props(wants, 318, 200, 3) == [("MIA", "DAL", "threes"), ("DEN", "GS", "threes"), ("UTAH", "MEM", "rebounds")]
    assert collect.plan_props(wants, 201, 200, 3) == [("MIA", "DAL", "threes")]
    assert collect.plan_props(wants, 199, 200, 3) == [] and collect.plan_props(wants, None, 200, 3) == []


def _row(pid, game, market="threes", p=0.85, line=2.5, mean=1.5, **ev):
    e = {"start_rate": 1, "minutes": 32, "season_games": 3, "season_starts": 3, "season_min": 32} | ev
    return {"player_id": pid, "game_id": game, "market": market, "p_over": 1 - p, "line": line, "mean": mean,
            "line_source": "usual", "out": False, "injury": None, "evidence": e}


def test_prop_targets_skip_bench_players_and_rank_by_chance():
    teams = {1: ("MIA", "DAL"), 2: ("UTAH", "MEM")}
    rows = [_row("a", 1, p=0.8), _row("b", 2, p=0.9, season_games=0, season_starts=0, season_min=None),
            _row("c", 2, market="rebounds", p=0.95, season_starts=0), _row("d", 2, market="assists", p=0.7),
            _row("e", 1, market="points", p=0.99, mean=9, line=21.5), {**_row("f", 1, p=0.97), "injury": "Questionable"}]
    assert pipeline.prop_targets(rows, teams) == [("MIA", "DAL", "threes"), ("UTAH", "MEM", "assists")]


def test_fetch_props_buys_once_and_saves_lines(tmp_path, monkeypatch):
    monkeypatch.setenv("NBA_ARCHIVE_DIR", str(tmp_path))
    monkeypatch.setenv("ODDS_API_KEY", "k")
    (tmp_path / "odds").mkdir()
    f = tmp_path / "odds" / "2026-10-26.json"
    f.write_text(json.dumps({"games": [{"event_id": "e1", "home": "MIA", "away": "DAL"}], "props": [],
                             "budget": {"reserve": 200}, "credits_remaining": 318, "errors": []}))
    calls = []

    def fake(url, params=None):
        calls.append(params["markets"])
        return ({"bookmakers": [{"key": "draftkings", "markets": [{"key": "player_threes", "outcomes": [
            {"name": "Under", "description": "P.J. Washington", "point": 2.5, "price": -150}]}]}]},
                {"x-requests-remaining": "317"})
    monkeypatch.setattr(collect, "_get_json", fake)
    got = collect.fetch_props("2026-10-26", [("MIA", "DAL", "threes"), ("DEN", "GS", "threes")])
    assert got["games"] == 1 and got["prices"] == 1 and calls == ["player_threes"]
    snap = json.loads(f.read_text())
    assert snap["props"][0]["player"] == "P.J. Washington" and snap["credits_remaining"] == 317
    assert collect.fetch_props("2026-10-26", [("MIA", "DAL", "threes")])["skipped"] == "props already bought today"


def test_official_injury_report_rows():
    text = ("Injury Report: 10/26/26 01:30 PM\n"
            "10/26/2026 08:00 (ET) MEM@UTA Memphis Grizzlies Small, Javon Out Injury/Illness - Left Ankle; Sprain\n"
            "Jackson Jr., Jaren Questionable Injury/Illness - Right Knee; Soreness\n"
            "Utah Jazz Williams, Cody Available\n"
            "09:00 (ET) GSW@DEN Golden State Warriors Curry, Stephen Probable Rest\n")
    rows = collect.parse_injury_report(text)
    assert [(r["name"], r["team"], r["status"]) for r in rows] == [
        ("Javon Small", "MEM", "Out"), ("Jaren Jackson Jr.", "MEM", "Questionable"),
        ("Cody Williams", "UTAH", "Available"),
        ("Stephen Curry", "GS", "Probable")]
    assert rows[0]["reason"].startswith("Injury/Illness - Left Ankle")
    # the same report extracted one table cell per line
    cells = ("10/26/2026\n08:00 (ET)\nMEM@UTA\nMemphis Grizzlies\nSmall, Javon\nOut\nInjury/Illness - Left Ankle; Sprain\n"
             "Jackson Jr., Jaren\nQuestionable\nInjury/Illness - Right Knee; Soreness\nUtah Jazz\nWilliams, Cody\nAvailable\n"
             "09:00 (ET)\nGSW@DEN\nGolden State Warriors\nCurry, Stephen\nProbable\nRest\n")
    split = collect.parse_injury_report(cells)
    assert [(r["name"], r["team"], r["status"]) for r in split] == [(r["name"], r["team"], r["status"]) for r in rows]
    assert split[0]["reason"].startswith("Injury/Illness - Left Ankle") and split[-1]["reason"] == "Rest"


def test_official_injury_report_one_word_per_line():
    # how the league's 10/28/26 report really extracted: one word per line, page headers mid-team
    text = "\n".join(("Injury Report: 10/28/26 05:30 AM Page 1 of 7 Game Date Game Time Matchup Team Player Name Current Status Reason "
                      "10/28/2026 07:00 (ET) CHA@DET Charlotte Hornets Knueppel, Kon Out Injury/Illness - Left Hamstring Strain "
                      "White, Coby Out Injury/Illness - Left Calf Strain Detroit Pistons NOT YET SUBMITTED MIA@ATL Miami Heat "
                      "Fontecchio, Simone Doubtful Injury/Illness - Illness PHI@IND Philadelphia 76ers Barlow, Dominick Out Injury/Illness - "
                      "Low Back Stress Reaction Injury Report: 10/28/26 05:30 AM Page 2 of 7 Fall, Tacko Out Injury/Illness - Left "
                      "Quadriceps Strain Indiana Pacers Haliburton, Tyrese Questionable Injury/Illness - Left Hamstring Strain").split())
    rows = collect.parse_injury_report(text)
    assert [(r["name"], r["team"], r["status"]) for r in rows] == [
        ("Kon Knueppel", "CHA", "Out"), ("Coby White", "CHA", "Out"), ("Simone Fontecchio", "MIA", "Doubtful"),
        ("Dominick Barlow", "PHI", "Out"), ("Tacko Fall", "PHI", "Out"), ("Tyrese Haliburton", "IND", "Questionable")]
    assert rows[1]["reason"] == "Injury/Illness - Left Calf Strain"
    assert rows[3]["reason"] == "Injury/Illness - Low Back Stress Reaction"


def test_official_report_overrides_espn(tmp_path, monkeypatch):
    from nba import predict
    monkeypatch.setenv("NBA_ARCHIVE_DIR", str(tmp_path))
    (tmp_path / "injuries").mkdir()
    (tmp_path / "official_injuries").mkdir()
    espn = {"data": {"injuries": [{"displayName": "Utah Jazz", "injuries": [
        {"athlete": {"displayName": "Cody Williams"}, "status": "Day-To-Day", "shortComment": "ankle"}]}]}}
    (tmp_path / "injuries" / "2026-10-26.json").write_text(json.dumps(espn))
    (tmp_path / "official_injuries" / "2026-10-26.json").write_text(json.dumps({"players": [
        {"name": "Cody Williams", "team": "UTAH", "status": "Available", "reason": ""},
        {"name": "Javon Small", "team": "MEM", "status": "Out", "reason": "Left Ankle"}]}))
    inj = predict.injuries()
    assert "cody williams" not in inj and inj["javon small"]["status"] == "Out"


def test_official_injury_page_uses_two_digit_second_year():
    assert collect.official_index_url(2027) == "https://official.nba.com/nba-injury-report-2026-27-season/"


def test_props_are_bought_only_once_books_post_them():
    from datetime import datetime, timezone
    assert not pipeline.props_posted(datetime(2026, 10, 27, 9, 0, tzinfo=timezone.utc))   # 5 am ET
    assert pipeline.props_posted(datetime(2026, 10, 27, 16, 0, tzinfo=timezone.utc))      # noon ET
    assert pipeline.props_posted(datetime(2026, 10, 27, 0, 30, tzinfo=timezone.utc))      # 8:30 pm ET the day before


def test_espn_draftkings_props_keep_the_main_line():
    def item(aid, name, line, dec):
        return {"athlete": {"$ref": f"http://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2027/athletes/{aid}?lang=en"},
                "type": {"id": "1", "name": name}, "odds": {"decimal": {"value": str(dec)}}, "current": {"target": {"value": line}}}
    items = [item(6475, "Total Points", 8.5, 1.75), item(6475, "Total Points", 8.5, 2.03),
             # an alternate line priced far from even loses to the main one
             item(6475, "Total Points", 12.5, 1.2), item(6475, "Total Points", 12.5, 4.5),
             item(6475, "Total 3-Point Field Goals", 1.5, 1.9), item(6475, "Total 3-Point Field Goals", 1.5, 1.9),
             item(6475, "Total Steals", 0.5, 1.9), item(6475, "Total Steals", 0.5, 1.9),
             # half a pair is not a posted line
             item(99, "Total Rebounds", 6.5, 1.9),
             # whole numbers are milestones or in-game lines, even when evenly priced
             item(7, "Total Points", 45.0, 1.91), item(7, "Total Points", 45.0, 1.91)]
    got = sorted((r["player_id"], r["market"], r["line"]) for r in collect.parse_espn_props(items))
    assert got == [("6475", "points", 8.5), ("6475", "threes", 1.5)]
    assert collect.espn_prop_market("Total Points, Rebounds and Assists") == "pra"
    assert collect.espn_prop_market("Total Assists") == "assists"
    assert collect.espn_prop_market("Total Steals") is None
