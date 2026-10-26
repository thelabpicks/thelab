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
