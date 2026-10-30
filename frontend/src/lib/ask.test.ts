import { describe, expect, it } from "vitest";
import { altPool, answer, answerFloorPicks, anyPool, estimatedLine, parse, type AskData } from "./ask";
import type { RankingRow } from "./types";

const row = (id: string, name: string, team: string, opp: string, pos: string, p: number, gid: string, day = "2026-10-25"): RankingRow =>
  ({ rank: 1, player_id: id, player_name: name, team, position: pos, opponent: opp, game_id: gid, gameday: day, eligible: true, exclusion: null,
    score: 50, p_model: p, confidence: null, flags: [], reasons: [], features: {}, outcome: null, participated: null }) as RankingRow;
const d: AskData = {
  season: 2026, week: 7, props: {}, conf: undefined, buckets: {}, useCorr: false, feed: { at: null, get: () => [] },
  td: [
    row("1", "Jahmyr Gibbs", "DET", "TB", "RB", 0.63, "2026_07_TB_DET", "2026-10-26"),
    row("2", "Amon-Ra St. Brown", "DET", "TB", "WR", 0.47, "2026_07_TB_DET", "2026-10-26"),
    row("3", "D'Andre Swift", "CHI", "NE", "RB", 0.54, "2026_07_NE_CHI", "2026-10-22"),
    row("4", "Rhamondre Stevenson", "NE", "CHI", "RB", 0.4, "2026_07_NE_CHI", "2026-10-22"),
    row("5", "Isaiah Likely", "NYG", "DAL", "TE", 0.3, "2026_07_DAL_NYG"),
    row("6", "George Pickens", "DAL", "NYG", "WR", 0.47, "2026_07_DAL_NYG"),
  ],
};

describe("ask parser", () => {
  it.each([
    ["Give me one TD scorer from each game this week", "pergame"],
    ["Top 5 TD scorers", "top"],
    ["give me 4 running backs likely to score", "top"],
    ["Safest 3-leg parlay", "parlay"],
    ["Best value bets", "value"],
    ["How accurate is the model?", "record"],
    ["any injuries on the lions", "injuries"],
    ["patriots bears", "game"],
    ["Will Swift score?", "player"],
    ["bets to avoid", "avoid"],
    ["longshot TD picks", "sleepers"],
    ["what can you do", "help"],
    ["Who will fall short this week?", "unders"],
    ["best unders for receivers", "unders"],
    ["who is due for a TD", "due"],
    ["What props have a 100% hit rate?", "hitrate"],
    ["unders that hit 90% of the time last 5", "hitrate"],
    ["who is on a hot streak", "hitrate"],
    ["worst defenses against running backs", "defense"],
    ["best matchups for WRs this week", "defense"],
    ["highest scoring games this week", "games"],
    ["what does edge mean", "glossary"],
    ["what is a tier", "glossary"],
    ["most projected receiving yards", "leaders"],
    ["What is the safest pick from all 14 games. It can be any prop", "any"],
    ["best bets this week any market", "any"],
    ["give me the highest rated prop from each game", "pergame"],
    ["highest rated props this week", "any"],
    ["any unlucky receivers due to bounce back", "due"],
  ])("%s -> %s", (q, intent) => expect(parse(d, q).intent).toBe(intent));

  it("reads filters, counts and lines", () => {
    expect(parse(d, "top 10 wide receivers to score").filters.position).toBe("WR");
    expect(parse(d, "top 10 wide receivers to score").n).toBe(10);
    expect(parse(d, "Thursday scorers").filters.day).toBe(4);
    const p = parse(d, "which QBs will throw for 250");
    expect([p.market, p.line, p.side]).toEqual(["pass_yards", 249.5, "over"]);
    expect(parse(d, "likely scorers").players).toEqual([]); // "likely" is a word here, not Isaiah Likely
  });

  it("picks the best proven scorer from each game", () => {
    // DAL at NYG has no 50%+ chance, so that game is left out.
    const a = answer(d, "one TD scorer from each game");
    expect(a.picks?.map((p) => p.name)).toEqual(["Jahmyr Gibbs", "D'Andre Swift"]);
  });

  it("limits a one-team question to that team and a matchup to that game", () => {
    expect(answer(d, "who scores for the bears").picks?.map((p) => p.team)).toEqual(["CHI"]);
    expect(answer(d, "patriots bears").groups?.[0].picks.map((p) => p.name)).toEqual(["D'Andre Swift", "Rhamondre Stevenson"]);
  });

  it("searches every market for an any-prop question and reads the slate size as context", () => {
    const p = parse(d, "What is the safest pick from all 14 games. It can be any prop");
    expect([p.intent, p.n]).toEqual(["any", 1]);
    const withProps: AskData = { ...d, props: { receptions: { label: "Receptions", rows: [{ player_id: "2", player_name: "Amon-Ra St. Brown", team: "DET", opponent: "TB",
      position: "WR", game_id: "2026_07_TB_DET", eligible: 1, median: 8, q10: 5, q90: 11, evidence: { receptions_med: 8 },
      dist: { type: "quantiles", q: Array.from({ length: 99 }, (_, i) => 3 + i * 0.1), platt: [1, 0] } }] } } };
    const a = answer(withProps, "safest pick, any prop");
    expect(a.picks?.length).toBe(1);
    expect(a.picks?.[0].market).not.toBe(undefined);
    expect(parse(d, "safest pick from each game, any market").intent).toBe("pergame");
    expect(answer(withProps, "safest pick from each game").title).toContain("any market");
    expect(answer(withProps, "give me the highest rated prop from each game").title).toContain("any market");
    expect(answer(withProps, "best prop from each game, no TDs").picks?.every((p) => p.market !== "td")).toBe(true);
    expect(answer(d, "one TD scorer from each game").title).toContain("TD scorer");    // The parlay builder's "All markets" list keeps every leg, not just each player's best one.
    const every = anyPool(withProps, {}, undefined, false);
    expect(every.filter((p) => p.player_id === "2").map((p) => p.market).sort()).toEqual(["receptions", "td"]);
    expect(anyPool(withProps).filter((p) => p.player_id === "2")).toHaveLength(1);
    expect(every.map((p) => p.p)).toEqual([...every.map((p) => p.p)].sort((a, b) => b - a));
  });

  it("never shows a line from a different role (a backup's 4.5 pass attempts once he starts)", () => {
    expect(estimatedLine({ median: 23.9, evidence: { attempts_med: 4 } }, "pass_attempts")).toEqual({ line: 23.5, kind: "projected" });
    expect(estimatedLine({ median: 37.2, evidence: { attempts_med: 38.5 } }, "pass_attempts")).toEqual({ line: 38.5, kind: "usual" });
  });

  it("leaves out backup quarterbacks and players without a real role", () => {
    const q = (id: string, name: string, att: number, snap: number) => ({ player_id: id, player_name: name, team: "ATL", opponent: "SF", position: "QB",
      game_id: "2026_07_SF_ATL", eligible: 1, median: 0, q10: 0, q90: 2, evidence: { interceptions_med: 0, attempts_pg: att, snap_pct: snap },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => i / 60), platt: [1, 0] as [number, number] } });
    const wr = { ...q("w", "Deep Reserve", 0, 0.1), position: "WR" };
    const dd: AskData = { ...d, props: { interceptions: { label: "Interceptions thrown", rows: [q("s", "Starter Qb", 30, 0.98), q("b", "Backup Qb", 15, 0.4), wr] } } };
    const names = answer(dd, "safest pick any prop, no TDs").picks?.map((p) => p.name) ?? [];
    expect(names).toContain("Starter Qb");
    expect(names).not.toContain("Backup Qb");
    expect(names).not.toContain("Deep Reserve");
  });

  it("explains why a pick leans the way it does", () => {
    const henry = { player_id: "h", player_name: "Hunter Henry", team: "NE", opponent: "CHI", position: "TE", game_id: "2026_07_NE_CHI", eligible: 1,
      median: 3.6, q10: 1, q90: 6, recent: [2, 3, 5, 2, 3, 4, 1, 6].map((v, i) => ({ season: 2026, week: 6 - i, opponent: "BUF", value: v })),
      evidence: { receptions_med: 4, receptions_l3: 3.3, receptions_cur: 3.5, opp_receptions_mult: 0.85, targets_pg: 5.1, snap_pct: 0.8, team_implied_total: 19.5 },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => 0.5 + i * 0.065), platt: [1, 0] as [number, number] } };
    const dd: AskData = { ...d, props: { receptions: { label: "Receptions", rows: [henry] } } };
    const p = parse(dd, "Why is it suggesting Hunter Henry's under?");
    expect(p.intent).toBe("why");
    const a = answer(dd, "Why is it suggesting Hunter Henry's under?");
    expect(a.picks?.[0].side).toBe("under");
    expect(a.picks?.[0].reasons?.some((r) => r.includes("CHI allows 15% fewer"))).toBe(true);
    const facts = a.sections!.flatMap((x) => x.lines);
    expect(facts.some((n) => n.startsWith("Projection 3.6"))).toBe(true);
    expect(facts.some((n) => n.includes("Last 8 games"))).toBe(true);
  });

  it("builds parlays from every market unless TDs are asked for", () => {
    expect(answer(d, "Give me the best 3 leg parlay for tonights game").title).toContain("any market");
    expect(answer(d, "3 leg TD parlay").title).toContain("TD parlay");
  });

  it("takes each player's likeliest alternate line that books post at -500 or longer and that beats its price", () => {
    const wr = { player_id: "2", player_name: "Amon-Ra St. Brown", team: "DET", opponent: "TB", position: "WR", game_id: "2026_07_TB_DET", eligible: 1,
      median: 7, q10: 4, q90: 10, recent: [], evidence: { receptions_med: 7, snap_pct: 0.9 },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => 3 + i * 0.08), platt: [1, 0] as [number, number] } };
    const rows = [{ line: 6.5, price: -110 }, { line: 4.5, price: -300, alt: true }, { line: 3.5, price: -900, alt: true }, { line: 5.5, price: -150, alt: true }]
      .map((r) => ({ ...r, market: "receptions", player_id: "2", side: "over", book: "DraftKings" }));
    const dd: AskData = { ...d, props: { receptions: { label: "Receptions", rows: [wr] } },
      feed: { at: "2026-10-22T01:00:00Z", get: (m, p, s) => rows.filter((r) => r.market === m && r.player_id === p && r.side === s) } };
    const a = altPool(dd);
    expect(a.map((p) => [p.line, p.price, p.label])).toEqual([[4.5, -300, "Over 4.5 receptions (alt line)"]]);
    expect(a[0].p).toBeGreaterThan(0.75);
  });

  it("finds props at a hit rate and builds a player's ladder", () => {
    const rec = [6, 7, 8, 6, 9, 7, 6, 10].map((v, i) => ({ season: 2026, week: 6 - i, opponent: "BUF", value: v }));
    const wr = { player_id: "2", player_name: "Amon-Ra St. Brown", team: "DET", opponent: "TB", position: "WR", game_id: "2026_07_TB_DET", eligible: 1,
      median: 7, q10: 4, q90: 10, recent: rec, evidence: { receptions_med: 7, snap_pct: 0.9 },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => 3 + i * 0.08), platt: [1, 0] as [number, number] } };
    // Hit rates list only lines a book posts. Here a main line of 5.5 and an alternate 6.5.
    const feedOf = (rows: { market: string; player_id: string; line: number; alt?: boolean }[]) => {
      const all = rows.flatMap((r) => (["over", "under"] as const).map((side) => ({ ...r, side, book: "DraftKings", price: -110 })));
      return { at: "2026-10-22T01:00:00Z", get: (m: string, p: string, s: string) => all.filter((r) => r.market === m && r.player_id === p && r.side === s) };
    };
    const noBook: AskData = { ...d, props: { receptions: { label: "Receptions", rows: [wr] } } };
    expect(answer(noBook, "What props have a 100% hit rate?").title).toContain("need the books");
    const dd: AskData = { ...noBook, feed: feedOf([{ market: "receptions", player_id: "2", line: 5.5 }, { market: "receptions", player_id: "2", line: 6.5, alt: true }]) };
    const a = answer(dd, "What props have a 100% hit rate?");
    expect(a.picks?.[0].label).toBe("Over 5.5 receptions");
    expect(a.picks?.[0].reasons?.[0]).toContain("8 of 8");
    const b = answer(dd, "what props hit 60% of the time");
    expect(b.picks?.[0].label).toBe("Over 6.5 receptions");
    const l = answer(dd, "St. Brown alt lines receptions");
    expect(l.table?.rows.some((r) => String(r[0]).startsWith("5.5") && String(r[3]).startsWith("8 of 8"))).toBe(true);    // Only lines a book would offer: a QB with one 54-yard game has no 100% passing-yards line, never "over 50.5".
    const qrec = [281, 329, 291, 287, 361, 266, 54, 191].map((v, i) => ({ season: 2026, week: 6 - i, opponent: "TB", value: v }));
    const qb = { player_id: "9", player_name: "Bryce Young", team: "CAR", opponent: "TB", position: "QB", game_id: "2026_07_TB_CAR", eligible: 1,
      median: 241, q10: 147, q90: 327, recent: qrec, evidence: { pass_yards_med: 284, attempts_pg: 33, snap_pct: 1 },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => 120 + i * 2.4), platt: [1, 0] as [number, number] } };
    const qd: AskData = { ...d, props: { pass_yards: { label: "Passing yards", rows: [qb] } }, feed: feedOf([{ market: "pass_yards", player_id: "9", line: 230.5 }]) };
    expect(answer(qd, "What props have a 100% hit rate?").picks ?? []).toHaveLength(0);
    expect(answer(qd, "what props have a 70% hit rate").picks?.[0].line).toBe(230.5);
    // A player the books don't post is never listed, however often he cleared some line.
    expect(answer({ ...qd, feed: feedOf([]) }, "what props have a 70% hit rate").picks ?? []).toHaveLength(0);
    const lad = answer(qd, "Bryce Young passing yards alt lines");
    expect(lad.table?.rows.every((r) => parseFloat(String(r[0])) >= 168)).toBe(true);
  });

  it("floor picks: the highest posted over line at a bettable price the model gives 80%+ that he kept clearing", () => {
    const rec = [6, 7, 8, 6, 9, 7, 6, 10].map((v, i) => ({ season: 2026, week: 6 - i, opponent: "BUF", value: v }));
    const wr = { player_id: "2", player_name: "Amon-Ra St. Brown", team: "DET", opponent: "TB", position: "WR", game_id: "2026_07_TB_DET", eligible: 1,
      median: 7, q10: 4, q90: 10, recent: rec, evidence: { receptions_med: 7, snap_pct: 0.9 },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => 3 + i * 0.08), platt: [1, 0] as [number, number] } };
    const at = (line: number, price: number) => ({ market: "receptions", player_id: "2", line, side: "over", book: "DraftKings", price });
    const feed = (rows: ReturnType<typeof at>[]) => ({ at: "2026-10-22T01:00:00Z", get: (m: string, p: string, s: string) => rows.filter((r) => r.market === m && r.player_id === p && r.side === s) });
    const dd = { ...d, props: { receptions: { label: "Receptions", rows: [wr] } }, feed: feed([at(2.5, -2000), at(3.5, -600), at(4.5, -350), at(6.5, -110)]) } as AskData;
    const a = answerFloorPicks(dd, 10, {}, { threshold: 1, window: 8 });
    // 2.5 is priced past -700; 4.5 is about 81%; 6.5 is under 80%
    expect(a.picks?.map((p) => [p.label, p.price])).toEqual([["5+ receptions", -350]]);
    expect(a.picks?.[0].reasons?.[0]).toContain("8 of 8");
    expect(answerFloorPicks({ ...dd, feed: feed([]) } as AskData, 10, {}, {}).picks ?? []).toHaveLength(0);
  });

  it("flags due players from expected vs actual TDs", () => {
    const due = { ...d, td: d.td.map((r) => (r.player_id === "6" ? { ...r, features: { cur_xtd: 3.4, cur_tds: 1, n_games_cur: 6 } } : r)) };
    const a = answer(due, "who is due for a touchdown");
    expect(a.picks?.map((p) => p.name)).toEqual(["George Pickens"]);
    expect(a.picks?.[0].due?.gap).toBeCloseTo(2.4);
  });

  it("uses same-game legs when only one game matches", () => {
    const thu = { ...d, td: d.td.map((r) => (r.player_id === "4" ? { ...r, p_model: 0.52 } : r)) };
    expect(answer(thu, "Thursday 2 leg parlay").picks?.length).toBe(2);
  });

  it("suggests only legs from tiers that hit 50%+ on unseen weeks", () => {
    const tier = (name: string, lo: number, hi: number, rate: number) => ({ tier: name, lo, hi, n: 200, hits: Math.round(rate * 200), rate, avg_chance: lo, ci: [null, null] as [null, null] });
    const conf = { td: { tiers: [tier("Long shot", 0, 0.2, 0.09), tier("Lean", 0.2, 0.35, 0.28), tier("Solid", 0.35, 0.5, 0.4), tier("Strong", 0.5, 1, 0.52)] } } as unknown as AskData["conf"];
    const a = answer({ ...d, conf }, "Safest 3-leg parlay");
    expect(a.picks?.every((p) => p.p >= 0.5)).toBe(true);
    expect(a.picks?.map((p) => p.name)).toEqual(["Jahmyr Gibbs", "D'Andre Swift"]);
  });

  it("reads half-point lines, passing-TD counts, nicknames and prices", () => {
    expect(parse(d, "passing touchdowns over 1.5").line).toBe(1.5);
    expect(parse(d, "Puka over 6.5 receptions").line).toBe(6.5);
    const two = parse(d, "who throws 2 touchdowns");
    expect([two.market, two.line]).toEqual(["pass_tds", 1.5]);
    expect(parse(d, "rush attempts").market).toBe("carries");
    expect(parse(d, "Is Swift a good bet at -160").intent).toBe("price");
    const a = answer(d, "Is Swift a good bet at -160");
    expect(a.title).toContain("overpriced"); // 54% vs 62% implied
    expect(answer(d, "Gibbs at +150").title).toContain("value"); // 63% vs 40% implied
  });

  it("does not confuse names or words", () => {
    expect(parse(d, "Jalen Hurts").intent).not.toBe("injuries");
    expect(answer(d, "Josh Allen passing yards").title).toContain("No numbers for Josh Allen");
    expect(parse(d, "Kyren or Gibbs").players.length).toBeGreaterThan(0);
    expect(parse(d, "best bets this week").intent).toBe("any");
    expect(parse(d, "what does Strong mean").intent).toBe("glossary");
  });

  it.each([["Why is Detroit favored?", "matchup"], ["who wins bears patriots", "matchup"], ["break down the lions game", "matchup"],
    ["why are these your picks", "whypicks"], ["explain your best bet", "whypicks"], ["patriots bears", "game"]])("%s -> %s", (q, intent) => expect(parse(d, q).intent).toBe(intent));

  it("writes up why a team is favored from the line, both defenses and the players", () => {
    const withLines: AskData = { ...d, td: [...d.td, row("9", "Mike Evans", "TB", "DET", "WR", 0.36, "2026_07_TB_DET", "2026-10-26")].map((r) => ({ ...r, features: { team_implied_total: r.team === "DET" ? 28.5 : r.team === "TB" ? 21 : 22 } })),
      defenses: { league: { RB: { tds_pg: 0.8, xtd_pg: 0.8 }, WR: { tds_pg: 0.9, xtd_pg: 0.9 }, TE: { tds_pg: 0.3, xtd_pg: 0.3 }, QB: { tds_pg: 0.2, xtd_pg: 0.2 }, rz_td_rate: 0.55 },
        scheme_league: { blitz_rate: 0.25, man_rate: 0.3 },
        teams: [
          { defense: "TB", games: 6, available: true, points_allowed_pg: 27.2, offensive_tds_allowed_pg: 3.1, xtd_allowed_pg: 2.9, rz_td_rate_allowed: 0.66, plays_faced_pg: 64,
            positions: { RB: { tds: 7, tds_pg: 1.2, xtd_pg: 1.1 }, WR: { tds: 5, tds_pg: 0.8, xtd_pg: 0.9 } }, scheme: { rates: { blitz_rate: 0.35, man_rate: 0.2 }, top_shell: ["Cover 3", 0.38] } },
          { defense: "DET", games: 6, available: true, points_allowed_pg: 18.0, offensive_tds_allowed_pg: 2.0, xtd_allowed_pg: 2.1, rz_td_rate_allowed: 0.5, plays_faced_pg: 62,
            positions: { RB: { tds: 3, tds_pg: 0.5, xtd_pg: 0.6 } } }] } };
    const a = answer(withLines, "Why is Detroit favored?");
    const titles = a.sections!.map((x) => x.title);
    expect(titles.slice(0, 2)).toEqual(["The line", "Why DET is favored"]);
    const text = a.sections!.flatMap((x) => x.lines).join("\n");
    expect(text).toMatch(/DET is favored by about 7\.5/);
    expect(text).toMatch(/does not model NFL spreads/);
    expect(text).toMatch(/TB defense \(6 games before this week\): 27\.2 points/);
    expect(text).toMatch(/RBs \+50%/);
    expect(text).toMatch(/blitz rate 35% \(league 25%\)/);
    expect(text).toMatch(/Jahmyr Gibbs 63%/);
  });

  it("explains the top picks one by one", () => {
    const a = answer(d, "why are these your picks");
    expect(a.sections?.length).toBeGreaterThan(0);
    expect(a.sections![0].title).toMatch(/Jahmyr Gibbs/);
  });
});
