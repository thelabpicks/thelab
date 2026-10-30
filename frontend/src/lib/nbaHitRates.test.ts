import { describe, expect, it } from "vitest";
import { floorPicks, lineHitRates } from "./nbaHitRates";
import type { NbaRow } from "./nba";

const cdf = (mu: number) => Array.from({ length: 80 }, (_, k) => {
  let s = 0, t = Math.exp(-mu);
  for (let i = 0; i <= k; i++) { s += t; t *= mu / (i + 1); }
  return Math.min(1, s);
});
const row = (id: string, market: string, mu: number, line: number, recent: number[], extra: Partial<NbaRow> = {}): NbaRow => ({
  player_id: id, player_name: `P${id}`, team: "NY", opp: "BOS", pos: "G", home: 1, game_id: 1, injury: null, injury_note: null,
  out: false, market, mean: mu, q10: mu - 5, q90: mu + 5, line, line_source: "book", usual_line: line, dk_line: line,
  dist: { type: "nbinom", n: 50, p: 0.5, cdf: cdf(mu), platt: [1, 0] }, p_over: null, offers: [], recent, recent_minutes: recent.map(() => 34),
  due: false, evidence: { minutes: 34, minutes_long: 34, per_min: 0.7, opp_mult: 1, pace: 100, opp_pace: 100, rest: 2, start_rate: 1 }, ...extra,
});
const brunson = [27, 26, 30, 22, 28, 31, 25, 24, 29, 27];

describe("nba hit rates", () => {
  it("floor picks take the highest DraftKings rung at a bettable price the model gives 80%+ that he kept reaching", () => {
    const ladder: [number, number][] = [[10, -5000], [15, -1500], [20, -446], [25, -150], [30, 160]];
    const [p] = floorPicks([row("1", "points", 27, 26.5, brunson, { milestones: ladder })], { threshold: 1, window: 10 });
    expect(p.milestone).toBe(20);   // 25+ is about 69%, under the bar; 15+ is priced past -700
    expect(p.price).toBe(-446);
    expect(p.chance).toBeGreaterThan(0.8);
    // a rung the model and the price disagree on wildly is a misread ladder, never a pick
    expect(floorPicks([row("1", "points", 27, 26.5, brunson, { milestones: [[20, 140]] })], { threshold: 1, window: 10 })).toEqual([]);
    expect(p.l5).toEqual([5, 5]);
    expect(p.l10).toEqual([10, 10]);
  });
  it("leaves out rungs DraftKings doesn't post, players not sure to play, and broken streaks", () => {
    expect(floorPicks([row("5", "points", 27, 26.5, brunson)], { threshold: 1, window: 10 })).toEqual([]);   // no ladder posted
    const ladder: [number, number][] = [[20, -446]];
    const rows = [
      row("2", "points", 27, 26.5, brunson, { dk_line: null, line_source: "usual", milestones: ladder }),
      row("3", "points", 27, 26.5, brunson, { out: true, injury: "Out", milestones: ladder }),
      row("4", "points", 27, 26.5, [27, 8, 30, 22, 28, 31, 25, 24, 29, 27], { milestones: ladder }),
    ];
    expect(floorPicks(rows, { threshold: 1, window: 10 })).toEqual([]);
    expect(floorPicks(rows, { threshold: 0.9, window: 10 }).map((p) => p.row.player_id)).toEqual(["4"]);
  });
  it("line hit rates use DraftKings' line on the chosen side", () => {
    const r = row("1", "points", 27, 21.5, brunson);
    expect(lineHitRates([r], { threshold: 1, window: 10, side: "over" }).map((p) => p.l10)).toEqual([[10, 10]]);
    expect(lineHitRates([r], { threshold: 1, window: 5, side: "under" })).toEqual([]);
  });
});
