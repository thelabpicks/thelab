import { describe, expect, it } from "vitest";
import { buildAnswers, firstRecord, gradeAnswers, type RunFacts } from "./simanswers";
import { parseFirst } from "./simgrades";

const base = { key: "nfl-2026-11-02-car-gb", sport: "nfl" as const, game: "CAR at GB", away: "CAR", home: "GB", start: "2026-11-02T18:00:00Z" };
const players = [
  { ti: 0, team: "CAR", name: "Chuba Hubbard", key: "c1" },
  { ti: 1, team: "GB", name: "Josh Jacobs", key: "g1" },
  { ti: 1, team: "GB", name: "Christian Watson", key: "g2" },
];
const run = (score: [number, number], first: [number, string] | null, box: RunFacts["box"]): RunFacts => ({ score, first, box });
const runs: RunFacts[] = [
  run([17, 24], [1, "g1"], [{ c1: { rutd: 1 } }, { g1: { rutd: 2 }, g2: { rtd: 1 } }]),
  run([21, 20], [0, "c1"], [{ c1: { rutd: 1 } }, { g1: { rutd: 1 } }]),
  run([10, 27], [1, "g1"], [{}, { g1: { rutd: 1 } }]),
  run([3, 6], null, [{}, {}]),
];

describe("ask the sims", () => {
  const a = buildAnswers(base, players, runs, [{ who: "Josh Jacobs", market: "rush_yards", side: "under", line: 59.5 }], [], new Date("2026-11-01T00:00:00Z"));

  it("counts first scorers, touchdown scorers, wins and average points from the runs", () => {
    expect(a.first).toEqual([{ team: "GB", name: "Josh Jacobs", chance: 0.5 }, { team: "CAR", name: "Chuba Hubbard", chance: 0.25 }]);
    expect(a.none).toBe(0.25);
    // a player with two touchdowns in a run still counts that run once
    expect(a.anytime![0]).toEqual({ team: "GB", name: "Josh Jacobs", chance: 0.75 });
    expect(a.win).toEqual({ CAR: 0.25, GB: 0.75 });
    expect(a.avg).toEqual({ CAR: 12.8, GB: 19.3 });
    expect(a.picks[0].who).toBe("Josh Jacobs");
  });

  it("has no touchdown lists for the NBA", () => {
    const n = buildAnswers({ ...base, sport: "nba" }, players, runs, [], []);
    expect(n.anytime).toBeUndefined();
    expect(n.none).toBeUndefined();
  });

  it("grades the first scorer by name and team, and keeps a record against what the sims expected", () => {
    const hit = gradeAnswers(structuredClone(a), { first: { team: "GB", name: "Josh Jacobs Jr." } });
    expect(hit.actual).toMatchObject({ chance: 0.5, top: true });
    const miss = gradeAnswers(structuredClone(a), { first: { team: "GB", name: "Tucker Kraft" } });
    expect(miss.actual).toMatchObject({ chance: 0, top: false });
    const none = gradeAnswers(structuredClone(a), {});
    expect(none.actual).toBeNull();
    expect(firstRecord([hit, miss, none], "nfl")).toEqual({ sport: "nfl", games: 2, top_hits: 1, expected: 1, listed: 1 });
  });

  it("reads the first field goal and the first touchdown from ESPN's play-by-play", () => {
    const header = { competitions: [{ competitors: [{ team: { id: "9", abbreviation: "GS" } }, { team: { id: "13", abbreviation: "LAL" } }] }] };
    const nba = { header, plays: [
      { text: "Jump ball", scoringPlay: false },
      { text: "Luka Doncic makes free throw 1 of 2", scoringPlay: true, scoreValue: 1, team: { id: "13" } },
      { text: "Stephen Curry makes 26-foot three point jumper (Draymond Green assists)", scoringPlay: true, scoreValue: 3, team: { id: "9" } },
    ] };
    expect(parseFirst("nba", nba)).toEqual({ team: "GS", name: "Stephen Curry" });
    const nfl = { scoringPlays: [
      { type: { abbreviation: "FG" }, text: "Brandon McManus 45 Yd Field Goal", team: { abbreviation: "GB" } },
      { type: { abbreviation: "TD" }, text: "Christian Watson 12 Yd pass from Jordan Love (Brandon McManus Kick)", team: { abbreviation: "GB" } },
    ] };
    expect(parseFirst("nfl", nfl)).toEqual({ team: "GB", name: "Christian Watson" });
    // ESPN's WSH is our WAS
    expect(parseFirst("nfl", { scoringPlays: [{ scoringType: { name: "touchdown" }, text: "Terry McLaurin 30 Yd pass from Jayden Daniels", team: { abbreviation: "WSH" } }] }))
      .toEqual({ team: "WAS", name: "Terry McLaurin" });
    expect(parseFirst("nba", { plays: [] })).toBeNull();
  });
});
