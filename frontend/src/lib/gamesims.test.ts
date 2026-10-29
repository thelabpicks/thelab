import { describe, expect, it } from "vitest";
import { nbaChecks, nbaSimGames, nflSimGames, type FrozenWeek, type HeldGame } from "./gamesims";
import type { Slate } from "./nba";

const team = (implied: number | null, qbStatus: string | null = null): FrozenWeek["games"][string]["teams"][string] => ({
  inputs: [
    { player_id: "q", player_name: "Q B", position: "QB", team_implied_total: implied, status: qbStatus },
    { player_id: "q2", player_name: "Back Up", position: "QB", team_implied_total: implied },
    { player_id: "r", player_name: "R B", position: "RB", team_implied_total: implied },
    { player_id: "w", player_name: "W R", position: "WR", team_implied_total: implied },
  ],
  players: {
    q: { attempts: { mean: 33 }, completions: { mean: 22 }, pass_yards: { mean: 240 }, pass_tds: { mean: 1.6 }, interceptions: { mean: 0.7 }, carries: { mean: 2 } },
    q2: { carries: { mean: 0.1 } },
    r: { carries: { mean: 16 }, rush_yards: { mean: 70 }, targets: { mean: 3 }, rec_yards: { mean: 40 } },
    w: { targets: { mean: 8 }, receptions: { mean: 5.5 }, rec_yards: { mean: 150 } },
  },
});

describe("game sim inputs", () => {
  it("keeps NFL games both teams can be replayed for, in kickoff order, without backup quarterbacks", () => {
    const week: FrozenWeek = { season: 2026, week: 8, games: {
      "2026_08_A_B": { game_id: "2026_08_A_B", kickoff: "2026-11-01T17:00:00Z", teams: { A: team(21), B: team(24) } },
      "2026_08_C_D": { game_id: "2026_08_C_D", kickoff: "2026-10-30T00:15:00Z", teams: { C: team(20), D: team(23) } },
      "2026_08_E_F": { game_id: "2026_08_E_F", kickoff: "2026-11-01T17:00:00Z", teams: { E: team(20, "Out"), F: team(23) } },
      "2026_08_G_H": { game_id: "2026_08_G_H", kickoff: "2026-11-01T17:00:00Z", teams: { G: team(null), H: team(23) } },
    } };
    const held: HeldGame[] = [];
    const out = nflSimGames(week, held);
    expect(out.games.map((g) => g.id)).toEqual(["2026_08_C_D", "2026_08_A_B"]);
    expect(held.map((h) => h.game)).toEqual(["2026_08_E_F", "2026_08_G_H"]);
    expect(out.games[1].teams.A.implied).toBe(21);
    expect(out.games[1].teams.A.players.map((p) => p.name)).toEqual(["Q B", "R B", "W R"]);
  });

  it("builds NBA games from the slate with the favorite and spread from the home line", () => {
    const rows = ["H", "V"].flatMap((t) => Array.from({ length: 9 }, (_, i) => ["points", "rebounds"].map((market) => ({
      player_id: `${t}${i}`, player_name: `${t} Player ${i}`, team: t, market, mean: market === "points" ? 19 - i : 5, out: i === 8,
      evidence: { minutes: 37 - 2 * i } })))).flat();
    const slate = { date: "2026-10-29", generated_at: "", odds: {}, rows,
      games: [{ game_id: 1, date: "2026-10-29", time: "2026-10-30T00:00Z", home: "H", away: "V", total: 230.5, home_spread: 4.5 },
        { game_id: 2, date: "2026-10-29", time: "2026-10-30T00:00Z", home: "X", away: "Y", total: null, home_spread: null }] } as unknown as Slate;
    const out = nbaSimGames(slate);
    expect(out.games).toEqual([{ away: "V", home: "H", start: "2026-10-30T00:00Z", total: 230.5, fav: "V", spread: 4.5 }]);
    expect(out.players.H).toHaveLength(8);
    expect(out.players.H[0]).toMatchObject({ min: 37, pts: 19, reb: 5 });
  });

  it("holds back an NBA game whose minutes add up far past 240", () => {
    const team = (min: number) => Array.from({ length: 9 }, () => ({ name: "P", min, pts: 115 / 9, reb: 4, ast: 3, tpm: 1 }));
    const g = { away: "V", home: "H", start: "", total: 230, fav: "H", spread: 0 };
    expect(nbaChecks(g, { V: team(26.7), H: team(26.7) })).toEqual([]);
    expect(nbaChecks(g, { V: team(36.5), H: team(26.7) })[0]).toMatch(/V projected minutes add up to 329/);
  });
});
