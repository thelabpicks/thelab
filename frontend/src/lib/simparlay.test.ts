import { describe, expect, it } from "vitest";
import { loadEngine, runBoxes } from "../../scripts/simengine";
import type { NbaSimPlayer } from "./gamesims";
import { chooseLegs, fairPrice, gradeParlay, legCandidates, parlayRecord, type RunBox, type SimParlay } from "./simparlay";

// 100 runs of one NBA team: player 0 scores i/2 points in run i, player 1 the same (they move together), player 2 the
// reverse, player 3 always 30 points and 3 threes
const boxes: RunBox[] = Array.from({ length: 100 }, (_, i) => [{
  "0": { pts: i / 2, reb: 5 }, "1": { pts: i / 2 }, "2": { pts: 50 - i / 2 }, "3": { pts: 30, tpm: 3 },
}]);
const players = ["A", "B", "C", "D"].map((name, i) => ({ ti: 0, team: "BOS", name, key: String(i) }));

describe("sim parlay", () => {
  it("sets each leg at the highest rung inside the chance band", () => {
    const c = legCandidates("nba", players, boxes);
    // A reaches 10+ in 80 of 100 runs, 15+ in 70: 10+ is the highest rung at 75-90%
    expect(c.find((x) => x.name === "A" && x.stat === "pts")).toMatchObject({ min: 10, chance: 0.8 });
    expect(c.find((x) => x.name === "A" && x.stat === "reb")).toBeUndefined();   // 4+ in every run: too sure to say anything
    expect(c.find((x) => x.name === "D")).toBeUndefined();
  });

  it("counts the joint chance from the runs, so legs that move together are not multiplied", () => {
    const c = legCandidates("nba", players, boxes);
    const p = chooseLegs(c, 100, { max: 3, min: 2, joint: 0 })!;
    // C (81 runs) first; A and B hit in the same 80 runs, so adding both costs no more than adding one: 61 runs
    expect(p.legs.map((l) => l.name)).toEqual(["C", "A", "B"]);
    expect(p.chance).toBe(0.61);
    expect(chooseLegs(c, 100)!.legs).toHaveLength(3);
    // fewer than 3 legs: no parlay
    expect(chooseLegs(legCandidates("nba", players.slice(0, 2), boxes), 100)).toBeNull();
  });

  it("grades each leg on the final: a hit, a miss, a player who did not play is void", () => {
    const p: SimParlay = { key: "nba-2026-10-29-bos-ny", sport: "nba", game: "BOS at NY", start: "2026-10-29T23:30:00Z", built_at: "", runs: 100,
      chance: 0.6, fair: -150, legs: [
        { team: "BOS", name: "A", stat: "pts", min: 10, chance: 0.8, median: 25 },
        { team: "BOS", name: "B", stat: "tpm", min: 2, chance: 0.8, median: 3 },
        { team: "BOS", name: "C", stat: "pts", min: 15, chance: 0.8, median: 25 },
      ] };
    const g = { final: { BOS: 110, NY: 104 }, players: [
      { team: "BOS", name: "A", stat: "pts" as const, proj: 25, actual: 12 },
      { team: "BOS", name: "B", stat: "pts" as const, proj: 20, actual: 14 },   // played, no threes line: 0
    ] };
    gradeParlay(p, g, new Date("2026-10-30T05:00:00Z"));
    expect(p.legs.map((l) => [l.actual, l.hit])).toEqual([[12, true], [0, false], [null, null]]);
    expect(p.hit).toBe(false);
    expect(parlayRecord([p], "nba")).toEqual({ sport: "nba", won: 0, lost: 1, legs_hit: 1, legs: 2 });
  });

  it("prices the chance as fair American odds", () => {
    expect(fairPrice(0.6)).toBe(-150);
    expect(fairPrice(0.4)).toBe(150);
  });

  it("runs the page's own engine: seeded, and centered on the projections", () => {
    const e = loadEngine();
    const team = (t: string): NbaSimPlayer[] => Array.from({ length: 9 }, (_, i) => ({
      name: `${t}${i}`, min: i < 5 ? 34 : 14, pts: i < 5 ? 18 : 7, reb: 5, ast: 3, tpm: 1.5 }));
    const g = { away: "BOS", home: "NY", start: "2026-10-30T23:30:00Z", total: 222, fav: "NY", spread: 2 };
    const G = e.nba(g, { BOS: team("B"), NY: team("N") });
    const a = runBoxes(e, G, 400), b = runBoxes(e, G, 400);
    expect(a[7]).toEqual(b[7]);
    const mean = a.reduce((s, x) => s + (x[0]["0"]?.pts ?? 0), 0) / a.length;
    expect(mean).toBeGreaterThan(15);
    expect(mean).toBeLessThan(21);
  });

  it("NFL: each player's average over the runs matches his projection, not an inflated one", () => {
    const e = loadEngine();
    const team = (t: string) => ({ implied: 23, players: [
      { id: `${t}qb`, name: `${t} QB`, pos: "QB", attempts: 30, completions: 18.6, pass_yards: 201, pass_tds: 1.5, interceptions: 0.8, carries: 3, rush_yards: 15 },
      { id: `${t}rb`, name: `${t} RB`, pos: "RB", carries: 17, rush_yards: 72, targets: 3, receptions: 2.4, rec_yards: 16 },
      { id: `${t}wr`, name: `${t} WR`, pos: "WR", targets: 9, receptions: 6, rec_yards: 80 },
      { id: `${t}wr2`, name: `${t} WR2`, pos: "WR", targets: 7, receptions: 4.5, rec_yards: 55 },
      { id: `${t}te`, name: `${t} TE`, pos: "TE", targets: 6, receptions: 4.2, rec_yards: 40 },
      { id: `${t}rb2`, name: `${t} RB2`, pos: "RB", carries: 6, rush_yards: 25, targets: 2, receptions: 1.5, rec_yards: 10 },
    ] });
    const G = e.nfl({ id: "2026_09_AAA_BBB", away: "AAA", home: "BBB", kickoff: "2026-11-01T18:00:00Z", teams: { AAA: team("A"), BBB: team("B") } } as never);
    const runs = runBoxes(e, G, 600);
    const avg = (id: string, k: string) => runs.reduce((s, b) => s + (b[0][id]?.[k] ?? 0), 0) / runs.length;
    expect(Math.abs(avg("Arb", "ruyd") - 72)).toBeLessThan(8);
    expect(Math.abs(avg("Awr", "ryd") - 80)).toBeLessThan(8);
    expect(Math.abs(avg("Aqb", "pyd") - 201)).toBeLessThan(20);
  });
});
