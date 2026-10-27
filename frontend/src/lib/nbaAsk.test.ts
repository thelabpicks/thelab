import { describe, expect, it } from "vitest";
import { answer } from "./nbaAsk";
import type { NbaRow, Slate } from "./nba";

const cdf = (mu: number) => Array.from({ length: 80 }, (_, k) => {
  // Poisson CDF, good enough for routing tests
  let s = 0, t = Math.exp(-mu);
  for (let i = 0; i <= k; i++) { s += t; t *= mu / (i + 1); }
  return Math.min(1, s);
});
const row = (id: string, name: string, team: string, game: number, market: string, mu: number, line: number, extra: Partial<NbaRow> = {}): NbaRow => ({
  player_id: id, player_name: name, team, opp: team === "NY" ? "BOS" : "NY", pos: "G", home: 1, game_id: game, injury: null, injury_note: null,
  out: false, market, mean: mu, q10: mu - 5, q90: mu + 5, line, line_source: "book", usual_line: line,
  dist: { type: "nbinom", n: 50, p: 0.5, cdf: cdf(mu), platt: [1, 0] }, p_over: null,
  offers: (["over", "under"] as const).map((side) => ({ book: "draftkings", side, line, price: -110 })), recent: [mu, mu, mu, mu], recent_minutes: [34, 34, 34, 34],
  due: false, evidence: { minutes: 34, minutes_long: 34, per_min: 0.7, opp_mult: 1, pace: 100, opp_pace: 100, rest: 2, start_rate: 1 }, ...extra,
});
const slate: Slate = {
  date: "2026-10-22", generated_at: "", odds: { fetched_at: null, plan: "free", props_priced: false },
  games: [
    { game_id: 1, home: "NY", away: "BOS", time: "2026-10-22T23:30:00Z", total: 221.5, home_spread: -3.5 } as Slate["games"][number],
    { game_id: 2, home: "LAL", away: "OKC", time: "2026-10-23T02:00:00Z", total: 224.5, home_spread: 4.5 } as Slate["games"][number],
  ],
  rows: [
    row("1", "Jalen Brunson", "NY", 1, "points", 27, 22.5),
    row("2", "Jayson Tatum", "BOS", 1, "points", 26, 30.5),
    row("3", "Luka Doncic", "LAL", 2, "points", 30, 29.5, { due: true }),
    row("1", "Jalen Brunson", "NY", 1, "assists", 7, 6.5),
    row("1", "Jalen Brunson", "NY", 1, "threes", 0.3, 0.5),
    row("4", "Hurt Guy", "NY", 1, "points", 20, 19.5, { out: true, injury: "Out" }),
    row("5", "Jaylen Brown", "BOS", 1, "points", 22, 25.5),
    row("6", "Bruce Brown", "NY", 1, "points", 8, 10.5),
    row("7", "Shai Gilgeous-Alexander", "OKC", 2, "points", 31, 30.5),
    row("7", "Shai Gilgeous-Alexander", "OKC", 2, "rebounds", 5, 6.5),
  ],
};

describe("nba ask", () => {
  it("suggests only stars with a DraftKings line, but still answers for a player asked by name", () => {
    const noDk = { offers: [{ book: "bovada", side: "under" as const, line: 30.5, price: -110 }] };
    const s2: Slate = { ...slate, rows: slate.rows.map((r) => (r.player_id === "2" ? { ...r, ...noDk } : r)).concat([
      row("8", "Deep Bench", "NY", 1, "points", 3, 9.5, { evidence: { ...slate.rows[0].evidence, start_rate: 0.05 } })]) };
    const best = answer("best bets tonight", s2).items.map((x) => x.row.player_id);
    expect(best.length).toBeGreaterThan(0);
    expect(best).not.toContain("2");
    expect(best).not.toContain("8");
    expect(answer("Deep Bench points", s2).title).toContain("Deep Bench");
  });
  it.skipIf(!process.env.PEEK)("peek", () => {
    const a = answer(process.env.PEEK as string, slate);
    console.log([a.title, a.text, ...(a.sections ?? []).map((s) => `## ${s.title}\n${s.lines.map((l) => `- ${l}`).join("\n")}`), ...(a.bullets ?? [])].join("\n"));
  });

  it("answers a player threshold question from the distribution", () => {
    const a = answer("Will Brunson score 25 points?", slate);
    expect(a.items).toHaveLength(1);
    expect(a.items[0].line).toBe(24.5);
    expect(a.items[0].p).toBeGreaterThan(0.5);
  });
  it("builds a parlay one leg per game, and adds legs from the same games when asked for more legs than games", () => {
    const two = answer("2-leg parlay", slate);
    expect(new Set(two.items.map((x) => x.row.game_id)).size).toBe(2);
    const four = answer("4-leg parlay", slate);
    expect(four.items).toHaveLength(4);
    expect(new Set(four.items.map((x) => x.row.player_id)).size).toBe(4);
    expect(four.items.some((x) => x.row.out)).toBe(false);
    expect(four.parlay?.joint).toBeGreaterThan(0);
    expect(answer("same game parlay", slate).items.length).toBeGreaterThanOrEqual(2);
  });
  it("filters unders and due players", () => {
    expect(answer("best unders", slate).items.every((x) => x.side === "under")).toBe(true);
    expect(answer("who is due?", slate).items.map((x) => x.row.player_id)).toEqual(["3"]);
  });
  it("knows nicknames, shared last names and players who aren't playing", () => {
    expect(answer("sga props", slate).title).toContain("Shai Gilgeous-Alexander");
    const browns = answer("brown points", slate);
    expect(browns.title).toContain("2 players named Brown");
    expect(browns.suggestions).toEqual(["Jaylen Brown points", "Bruce Brown points"]);
    expect(answer("will lebron score 25", slate).title).toBe("Lebron isn't on tonight's slate");
  });
  it("explains the side that was asked about and skips lines under 1.5", () => {
    const why = answer("why is tatum under", slate);
    expect(why.items[0].side).toBe("under");
    expect(why.sections?.map((x) => x.title)).toEqual(["The pick", "Why the model leans under", "His recent games", "Working against it"]);
    expect(answer("brunson props", slate).items.some((x) => x.row.market === "threes")).toBe(false);
    expect(answer("brunson last 3 games", slate).title).toBe("Jalen Brunson: last 3 games");
  });
  it("never leaves a question blank", () => {
    for (const q of ["", "asdfgh", "hello", "injuries", "schedule", "okc vs lakers preview", "who is hot", "edges", "best 3 picks", "most rebounds",
      "under 6.5 rebounds", "who gets 30 points", "how accurate is the model", "triple double", "minutes", "knicks props"]) {
      const a = answer(q, slate);
      expect(a.title.length, q).toBeGreaterThan(0);
      expect(a.items.length + (a.bullets?.length ?? 0) + (a.text ? 1 : 0), q).toBeGreaterThan(0);
    }
  });
  it("explains why a team is favored from the line, projections, injuries and pace", () => {
    const a = answer("Why are the Knicks favored?", slate);
    const titles = a.sections!.map((x) => x.title);
    expect(titles).toEqual(["The line", "What our projections add up to", "Why NY is favored", "Best props in this game"]);
    const text = a.sections!.flatMap((x) => x.lines).join("\n");
    expect(text).toMatch(/NY a 3\.5-point favorite with a total of 221\.5/);
    expect(text).toMatch(/does not bet NBA sides/);
    expect(text).toMatch(/NY is without Hurt Guy/);
    expect(answer("Celtics vs Knicks preview", slate).sections?.length).toBeGreaterThan(2);
  });

  it("explains the strongest leans", () => {
    const a = answer("Why are these your best picks?", slate);
    expect(a.sections!.length).toBe(3);
    const one = answer("explain your best bet tonight", slate);
    expect(one.sections![0].title).toBe("The pick");
  });

  it.each(["why are the knicks favored", "who wins celtics knicks", "celtics vs knicks breakdown", "Knicks Celtics prediction", "why is boston the underdog",
    "why tatum under", "explain brunson assists", "break down brunson", "how confident are you in brunson", "what's your take on Jaylen Brown",
    "why are these your best picks", "explain your top 2 leans", "why do you like your best bet"])("%s gets a write-up", (q) => {
    expect(answer(q, slate).sections?.length).toBeGreaterThan(0);
  });
});
