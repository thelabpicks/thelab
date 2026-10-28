import { describe, expect, it } from "vitest";
import { buildReport, reportText } from "./report";
import type { DailyPick, LabPick, LabState } from "./lab";

const pick = (o: Partial<LabPick>): LabPick => ({
  id: o.id ?? Math.random().toString(36), sport: "nba", game_id: "1", kickoff: "2026-10-27T23:00:00Z", matchup: "A at B", bet: o.id ?? "x", who: "x",
  market: "points", market_label: "Points", side: "under", line: 20.5, line_source: "book", price: null, book: null, score: 7.5, chance: 0.75,
  tier: "Strong", tier_rate: 0.7, tier_n: 100, headline: "", sections: [], link: "/", ...o,
});
const daily = (o: Partial<DailyPick>): DailyPick => ({ ...pick(o), date: o.date ?? "2026-10-27", slot: 1, chosen_at: "2026-10-27T12:00:00Z", ...o });
const NOW = new Date("2026-10-28T09:45:00Z");   // 4:45 am Central: the report for Oct 28 covers Oct 27

describe("buildReport", () => {
  const state: LabState = {
    updated_at: null, board: [],
    frozen: [
      pick({ id: "a", rank: 1, result: "won", actual: "Finished with 2" }),
      pick({ id: "b", rank: 2, result: "lost", actual: "Finished with 30", chance: 0.8 }),
      pick({ id: "c", rank: 3 }),                                                               // waiting on the box score
      pick({ id: "old", rank: 1, kickoff: "2026-10-25T23:00:00Z", result: "won", actual: "Finished with 1" }),
      pick({ id: "n", sport: "nfl", rank: 1, kickoff: "2026-10-26T00:20:00Z", result: "won", actual: "Finished with 11" }),
    ],
    daily: [
      daily({ id: "a", rank: 1, result: "won", actual: "Finished with 2" }),                  // also on the top 10
      daily({ id: "d", rank: 4, result: "lost", actual: "Finished with 9", game_id: "2" }),   // pick of the day only
      daily({ id: "w", sport: "cfb", result: "void", actual: "Withdrawn before kickoff: under the 60% floor for a pick of the day", withdrawn: true }),
      daily({ id: "t", date: "2026-10-28", kickoff: "2026-10-28T23:00:00Z", game_id: "3" }),
    ],
  };
  const r = buildReport({ state, previous: { date: "2026-10-27", results_date: "2026-10-26", generated_at: "", headline: "", sports: [], graded_ids: ["a"] },
    nba: { previous: { generated_at: "", days: [{ date: "2026-10-27", line_source: "usual", games: [{ game_id: 1, home: "B", away: "A", score: [100, 90],
      picks: [["1", "P1", "B", "points", "under", 20.5, 0.8, 15, 30, 0], ["2", "P2", "B", "threes", "under", 2.5, 0.72, 1.4, 1, 1], ["3", "P3", "A", "assists", "over", 4.5, 0.55, 5, 6, 1]] }] }] } } }, NOW);
  const nba = r.sports.find((s) => s.sport === "nba")!;

  it("dates the report by the morning and grades the day before", () => {
    expect([r.date, r.results_date]).toEqual(["2026-10-28", "2026-10-27"]);
    expect(nba.results.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("counts top 10 and picks of the day separately; a pick of the day keeps no top 10 rank", () => {
    expect(nba.day.top10).toMatchObject({ won: 1, lost: 1 });
    expect(nba.day.potd).toMatchObject({ won: 1, lost: 1 });
    expect(nba.record.top10).toMatchObject({ won: 2, lost: 1 });
    expect(nba.results.find((p) => p.id === "d")?.rank).toBeUndefined();
  });
  it("lists misses, picks still waiting, withdrawals and late grades", () => {
    expect(nba.findings.some((f) => f.startsWith("Miss: b"))).toBe(true);
    expect(nba.findings.some((f) => f.includes("waiting on a final stat line: c"))).toBe(true);
    expect(nba.late.map((p) => p.id)).toEqual(["old"]);
    expect(r.sports.find((s) => s.sport === "cfb")!.findings[0]).toMatch(/^Withdrawn before kickoff: w\. Reason: under the 60% floor/);
    expect(nba.today.map((p) => p.id)).toEqual(["t"]);
  });
  it("sums up the day and remembers what is graded", () => {
    expect(r.headline).toBe("Tue, Oct 27: CFB 1 void, NBA 1-2 with 1 pending.");
    expect(r.graded_ids).toEqual(expect.arrayContaining(["a", "b", "old", "n"]));
    expect(reportText(r)).toContain("NBA: 2-1 / 1-1");
  });
  it("grades every lean the model made, by confidence, and names the furthest miss", () => {
    expect(nba.model[0]).toBe("Every lean the model made on 1 game: 2-1 (67%). By confidence: 70%+ hit 50% of 2, under 60% hit 100% of 1.");
    expect(nba.model.at(-1)).toContain("P1 points (projected 15, had 30, line 20.5)");
  });
});
