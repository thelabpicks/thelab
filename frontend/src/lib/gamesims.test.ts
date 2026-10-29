import { describe, expect, it } from "vitest";
import type { SimGames } from "./gamesims";
import { applyPins, fitRotation, onGameDay, nbaChecks, nbaSimGames, nflSimGames, repairNba, repairNfl, simPicks, type FrozenWeek, type HeldGame } from "./gamesims";
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

const team0 = () => team(21);

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

  it("fits a rotation whose minutes run past 240: the deep bench sits, the last one in gets what is left", () => {
    const list = [36, 34, 32, 30, 28, 26, 24, 22, 20, 18].map((min, i) => ({ name: `P${i}`, min, pts: min / 2, reb: 4, ast: 2, tpm: 1 }));
    const fit = fitRotation(list);
    expect(fit.map((p) => p.min)).toEqual([36, 34, 32, 30, 28, 26, 24, 22, 8]);
    expect(fit.reduce((s, p) => s + p.min, 0)).toBe(240);
    expect(fit[8]).toMatchObject({ name: "P8", min: 8, pts: 4, reb: 1.6 });
  });

  it("builds NBA rotations from every projected player, shrinking a sometimes-benched player's line with his minutes", () => {
    const rot = (t: string) => Array.from({ length: 10 }, (_, i) => ({ player_id: `${t}${i}`, player_name: `${t} P${i}`, team: t,
      minutes: i === 9 ? 21 : 28 - i, minutes_expected: i === 9 ? 10.5 : 28 - i, pts: i === 9 ? 5 : 14 - i, reb: 5, ast: 3, tpm: 1 }));
    const slate = { date: "2026-10-29", generated_at: "", odds: {}, rows: [], rotation: [...rot("H"), ...rot("V")],
      games: [{ game_id: 1, date: "2026-10-29", time: "2026-10-30T00:00Z", home: "H", away: "V", total: 200, home_spread: -2 }] } as unknown as Slate;
    const out = nbaSimGames(slate);
    expect(out.games).toHaveLength(1);
    expect(out.players.H.reduce((s, p) => s + p.min, 0)).toBe(240);
    // P9 plays 21 minutes when he plays but sits half the time: 10.5 expected minutes, half his line
    const p9 = out.players.H.find((p) => p.name === "H P9")!;
    expect(p9).toMatchObject({ min: 10.5, pts: 2.5, reb: 2.5 });
  });

  it("fills a short rotation with a reserves line, but not one missing more than 48 minutes", () => {
    const list = [34, 32, 30, 28, 26, 24, 22, 20].map((min, i) => ({ name: `P${i}`, min, pts: min / 2, reb: 4, ast: 2, tpm: 1 }));
    const fit = fitRotation(list, "SAC");
    expect(fit).toHaveLength(9);
    expect(fit[8]).toEqual({ name: "SAC reserves", min: 24, pts: 10.08, reb: 4.32, ast: 2.16, tpm: 0.96, bench: true });
    expect(fitRotation(list.slice(0, 6), "SAC")).toHaveLength(6);
  });

  it("holds back an NBA game whose projections can't nearly fill 240 minutes or miss the book's points", () => {
    const team = (min: number, pts = 115) => Array.from({ length: 9 }, () => ({ name: "P", min, pts: pts / 9, reb: 4, ast: 3, tpm: 1 }));
    const g = { away: "V", home: "H", start: "", total: 230, fav: "H", spread: 0 };
    expect(nbaChecks(g, { V: team(26.7), H: team(26.7) })).toEqual([]);
    expect(nbaChecks(g, { V: team(26.7), H: team(26.7) }, { V: 329, H: 260 })).toEqual([]);
    expect(nbaChecks(g, { V: team(21), H: team(26.7) })[0]).toMatch(/V projected minutes add up to only 189/);
    expect(nbaChecks(g, { V: team(26.7, 80), H: team(26.7) })[0]).toMatch(/V projected points add up to 80/);
  });

  it("repairs a failed game and checks it again instead of hiding it", () => {
    const team = (pts: number, min = 26.7) => Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, min: i ? min : 46, pts: pts / 9, reb: 4, ast: 3, tpm: 1 }));
    const g = { away: "V", home: "H", start: "", total: 230, fav: "H", spread: 0 };
    const players = { V: team(115), H: team(115) };
    expect(nbaChecks(g, players).length).toBeGreaterThan(0);
    expect(repairNba(g, players)).toEqual(["V P0 minutes 46 cut to 44", "H P0 minutes 46 cut to 44"]);
    expect(nbaChecks(g, players)).toEqual([]);
    expect(players.V[0].min).toBe(44);
    // points far from the book are never bent to it: the game stays held until the projections are fixed
    const off = { V: team(90), H: team(115) };
    repairNba(g, off);
    expect(off.V.reduce((s, p) => s + p.pts, 0)).toBeCloseTo(90 - 10 * (2 / 46), 1);
    expect(nbaChecks(g, off).some((r) => r.startsWith("V projected points"))).toBe(true);

    const week: FrozenWeek = { season: 2026, week: 8, games: { "2026_08_A_B": { game_id: "2026_08_A_B", kickoff: null, teams: { A: team0(), B: team0() } } } };
    week.games["2026_08_A_B"].teams.A.players.w.rec_yards = { mean: 300 };
    const fixed: { game: string; fixes: string[] }[] = [];
    const out = nflSimGames(week, [], fixed as never);
    expect(out.games).toHaveLength(1);
    expect(fixed[0].fixes[0]).toMatch(/W R rec yards 300 capped at 160/);
    const rec = out.games[0].teams.A.players.reduce((s, p) => s + (p.rec_yards ?? 0), 0);
    expect(Math.abs(rec / 240 - 1)).toBeLessThan(0.3);
    expect(repairNfl(out.games[0])).toEqual([]);
  });

  it("passes along the live picks on tonight's simulated games only", () => {
    const nfl = { season: 2026, week: 8, games: [{ id: "2026_08_A_B" }] } as never;
    const nba = { date: "2026-10-29", games: [{ away: "MEM", home: "POR", start: "2026-10-30T02:00Z", total: 230, fav: "POR", spread: 3 }], players: {} };
    const pick = (o: object) => ({ sport: "nba", game_id: "1", kickoff: "2026-10-29T22:00:00-0400", matchup: "MEM at POR", who: "Ty Jerome",
      player_id: "4065733", market: "points", side: "under", line: 23.5, ...o });
    const out = simPicks({
      board: [pick({}), pick({ who: "Old Pick", kickoff: "2026-10-20T22:00:00-0400" }), pick({ sport: "nfl", game_id: "2026_08_A_B", who: "R B", market: "td", side: "yes", line: null })],
      daily: { picks: [pick({}), pick({ who: "Withdrawn", withdrawn: true })] },
    }, nfl, nba);
    expect(out.map((p) => `${p.game} ${p.who}`)).toEqual(["MEM at POR Ty Jerome", "2026_08_A_B R B"]);
  });

  it("keeps a posted replay's inputs until its pin runs out", () => {
    const game = (implied: number) => ({ id: "2026_08_A_B", away: "A", home: "B", kickoff: null, teams: { A: { implied, players: [] }, B: { implied, players: [] } } });
    const nfl = { season: 2026, week: 8, games: [game(24)] };
    const pin = { key: "nfl-a-b", sport: "nfl" as const, seed: 100105, until: "2026-10-31T00:00:00Z", game: game(21) };
    expect(applyPins([pin], nfl, new Date("2026-10-29T19:00:00Z"))).toHaveLength(1);
    expect(nfl.games[0].teams.A.implied).toBe(21);
    const later = { season: 2026, week: 8, games: [game(24)] };
    expect(applyPins([pin], later, new Date("2026-10-31T01:00:00Z"))).toEqual([]);
    expect(later.games[0].teams.A.implied).toBe(24);
  });

  it("shows a game's sim only from its game day (Eastern), and a pinned replay always", () => {
    const g = (id: string, kickoff: string) => ({ id, away: "A", home: "B", kickoff, teams: {} });
    const nfl = { season: 2026, week: 8, games: [g("thu", "2026-10-30T00:15:00Z"), g("sun", "2026-11-01T17:00:00Z"), g("pinned", "2026-11-02T01:20:00Z"), g("tue", "2026-10-27T00:15:00Z")] } as never as SimGames["nfl"];
    const nba = { date: "2026-10-30", games: [{ away: "V", home: "H", start: "2026-10-30T23:00Z", total: 220, fav: "H", spread: 2 }], players: { V: [], H: [], X: [] } };
    const pin = { key: "k", sport: "nfl" as const, seed: 1, until: "2026-11-03T00:00:00Z", game: nfl.games[2] };
    // Thursday 3 pm Eastern: tonight's 8:15 pm game (00:15 UTC Friday) is today's
    onGameDay({ nfl, nba }, [pin], new Date("2026-10-29T19:00:00Z"));
    expect(nfl.games.map((x) => x.id)).toEqual(["thu", "pinned", "tue"]);
    expect(nba.games).toEqual([]);
    expect(nba.players).toEqual({});
  });
});
