import { describe, expect, it } from "vitest";
import { advance, cfbCandidates, chooseDaily, grade, nbaCandidates, publish, rankBoard, tally, type LabPick } from "./lab";
import type { AltLine, CfbGame } from "./cfb";
import type { NbaConfidence, NbaRow, Slate } from "./nba";

const pick = (o: Partial<LabPick>): LabPick => ({
  id: o.id ?? Math.random().toString(36), sport: "nba", game_id: "1", kickoff: "2026-10-24T23:00:00Z", matchup: "A at B", bet: "x", who: "x",
  market: "points", market_label: "Points", side: "over", line: 20.5, line_source: "book", price: null, book: null, score: 7.5, chance: 0.75,
  tier: "Strong", tier_rate: 0.7, tier_n: 100, headline: "", sections: [], link: "/", ...o,
});
const sports = { nfl: { loaded: true, candidates: 0 }, nba: { loaded: true, candidates: 0 }, cfb: { loaded: true, candidates: 0 } };

describe("rankBoard", () => {
  it("ranks the likeliest to hit first, one per game and per player, numbered from 1", () => {
    const b = rankBoard([
      pick({ id: "a", chance: 0.70, game_id: "1", player_id: "p1" }),
      pick({ id: "b", chance: 0.82, game_id: "1", player_id: "p2" }),
      pick({ id: "c", sport: "cfb", chance: 0.66, score: 9.7, game_id: "1" }),
      pick({ id: "d", chance: 0.75, game_id: "2", player_id: "p2" }),
      pick({ id: "e", chance: 0.74, game_id: "3", player_id: "p3", line_source: "usual" }),
      pick({ id: "f", chance: 0.74, game_id: "4", player_id: "p4" }),
    ]);
    // a high college value rating does not lift a 66% pick above more likely ones
    expect(b.map((p) => [p.id, p.rank])).toEqual([["b", 1], ["f", 2], ["e", 3], ["c", 4]]);
  });
  it("gives each sport its own top 10", () => {
    const cands = ["nfl", "cfb", "nba"].flatMap((sp) => Array.from({ length: 12 }, (_, i) => pick({ sport: sp as LabPick["sport"], id: `${sp}${i}`, game_id: String(i), player_id: String(i), chance: 0.7 + i / 100 })));
    const s = advance({ updated_at: null, board: [], frozen: [] }, cands, {}, new Date("2026-10-20T00:00:00Z"));
    for (const sp of ["nfl", "cfb", "nba"]) {
      const l = s.board.filter((p) => p.sport === sp);
      expect(l.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(l[0].id).toBe(`${sp}11`);
    }
  });
  it("stops at 10 and returns fewer when fewer qualify", () => {
    expect(rankBoard(Array.from({ length: 14 }, (_, i) => pick({ game_id: String(i), player_id: String(i) }))).length).toBe(10);
    expect(rankBoard([pick({})]).length).toBe(1);
  });
});

describe("grade", () => {
  it("grades NBA props at the frozen line, voids players with no box score once later days are graded", () => {
    const p = pick({ game_id: "9", player_id: "5", side: "under", line: 20.5, kickoff: "2026-10-24T23:30:00Z" });
    expect(grade(p, { nba: { rows: [{ date: "2026-10-24", game_id: 9, player_id: "5", market: "points", actual: 18 }], through: "2026-10-24" } })?.result).toBe("won");
    expect(grade(p, { nba: { rows: [], through: "2026-10-24" } })).toBeNull();
    expect(grade(p, { nba: { rows: [], through: "2026-10-25" } })?.result).toBe("void");
  });
  it("grades college sides, totals and moneylines from the final score", () => {
    const res = { cfb: { "7": [24, 20] as [number, number] } };
    expect(grade(pick({ sport: "cfb", game_id: "7", market: "spread", side: "home", line: -3.5 }), res)?.result).toBe("won");
    expect(grade(pick({ sport: "cfb", game_id: "7", market: "spread", side: "away", line: 4 }), res)?.result).toBe("push");
    expect(grade(pick({ sport: "cfb", game_id: "7", market: "total", side: "over", line: 47.5 }), res)?.result).toBe("lost");
    expect(grade(pick({ sport: "cfb", game_id: "7", market: "team_total", team_side: "away", side: "under", line: 21.5 }), res)?.result).toBe("won");
    expect(grade(pick({ sport: "cfb", game_id: "7", market: "moneyline", side: "away", line: null }), res)?.result).toBe("lost");
  });
  it("grades NFL touchdowns and props, and voids players who sat", () => {
    const nfl = [{ game_id: "g", player_id: "1", market: "td", status: "graded" as const, actual: 1 },
      { game_id: "g", player_id: "2", market: "rec_yds", status: "graded" as const, actual: 40 },
      { game_id: "g", player_id: "3", market: "rec_yds", status: "void" as const, actual: null }];
    expect(grade(pick({ sport: "nfl", game_id: "g", player_id: "1", market: "td", side: "yes", line: null }), { nfl })?.result).toBe("won");
    expect(grade(pick({ sport: "nfl", game_id: "g", player_id: "2", market: "rec_yds", side: "over", line: 45.5 }), { nfl })?.result).toBe("lost");
    expect(grade(pick({ sport: "nfl", game_id: "g", player_id: "3", market: "rec_yds" }), { nfl })?.result).toBe("void");
  });
});

describe("advance", () => {
  it("regrades a voided pick once newer results show the player played", () => {
    const now = new Date("2026-10-26T20:00:00Z");
    const p = pick({ id: "v", sport: "nfl", game_id: "g", player_id: "1", market: "rec_yds", side: "over", line: 45.5,
      kickoff: "2026-10-25T17:00:00Z", result: "void", actual: "Did not play" });
    const s = advance({ updated_at: null, board: [], frozen: [p] }, [],
      { nfl: [{ game_id: "g", player_id: "1", market: "rec_yds", status: "graded", actual: 60 }] }, now);
    expect(s.frozen[0].result).toBe("won");
  });
  it("freezes picks from the last board once their game starts, and only lists games not yet started", () => {
    const now = new Date("2026-10-24T23:10:00Z");
    const started = pick({ id: "s", game_id: "9", player_id: "5", kickoff: "2026-10-24T23:00:00Z", rank: 1 });
    const later = pick({ id: "l", game_id: "10", player_id: "6", kickoff: "2026-10-25T01:00:00Z", rank: 2 });
    const s = advance({ updated_at: "2026-10-24T22:40:00Z", board: [started, later], frozen: [] },
      [{ ...started, score: 9.9 }, later, pick({ id: "n", game_id: "11", player_id: "7", kickoff: "2026-10-25T00:00:00Z", chance: 0.8 })], {}, now);
    expect(s.frozen.map((p) => [p.id, p.rank, p.frozen_at])).toEqual([["s", 1, "2026-10-24T22:40:00Z"]]);
    expect(s.board.map((p) => p.id)).toEqual(["n", "l"]);
    // a second run does not freeze it twice, and grades it once the result is in
    const s2 = advance(s, [], { nba: { rows: [{ date: "2026-10-24", game_id: 9, player_id: "5", market: "points", actual: 25 }], through: "2026-10-24" } }, now);
    expect(s2.frozen.length).toBe(1);
    expect(s2.frozen[0].result).toBe("won");
    const b = publish(s2, sports);
    expect(b.record.won).toBe(1);
    expect(b.notes.nba).toMatch(/No games/);
    expect(publish(s2, { ...sports, nba: { loaded: true, candidates: 3 } }).notes.nba).toMatch(/already started/);
  });
});

const cdf = (mu: number) => Array.from({ length: 80 }, (_, k) => {
  let s = 0, t = Math.exp(-mu);
  for (let i = 0; i <= k; i++) { s += t; t *= mu / (i + 1); }
  return Math.min(1, s);
});
const nbaRow = (id: string, game: number, mu: number, line: number, extra: Partial<NbaRow> = {}): NbaRow => ({
  player_id: id, player_name: `P${id}`, team: "NY", opp: "BOS", pos: "G", home: 1, game_id: game, injury: null, injury_note: null,
  out: false, market: "points", mean: mu, q10: mu - 5, q90: mu + 5, line, line_source: "usual", usual_line: line,
  dist: { type: "nbinom", n: 50, p: 0.5, cdf: cdf(mu), platt: [1, 0] }, p_over: null, offers: [], recent: [mu, mu, mu], recent_minutes: [34, 34, 34],
  due: false, evidence: { minutes: 34, minutes_long: 34, per_min: 0.7, opp_mult: 1, pace: 100, opp_pace: 100, rest: 2, start_rate: 1 }, ...extra,
});

describe("nbaCandidates", () => {
  it("keeps proven leans of stars sure to play at lines DraftKings posts, each with a write-up", () => {
    const dk = (line: number) => (["over", "under"] as const).map((side) => ({ book: "draftkings", side, line, price: -110 }));
    // each row its own team, so each is that team's top scorer unless a test says otherwise
    const at = (id: string, mu: number, line: number, extra: Partial<NbaRow> = {}) =>
      nbaRow(id, 1, mu, line, { team: `T${id}`, line_source: "book", offers: dk(line), ...extra });
    const tier = (name: string, lo: number, hi: number, rate: number) => ({ tier: name, lo, hi, n: 1000, hits: 0, rate, avg_chance: null, ci: [null, null] as [null, null] });
    const conf = { props: { first_season: 2022, tiers: [tier("Coin flip", 0.5, 0.55, 0.5), tier("Lean", 0.55, 0.6, 0.56), tier("Strong", 0.6, 1, 0.68)],
      by_side: { over: [], under: [] }, note: "", by_market: [] } } as NbaConfidence;
    const slate: Slate = { date: "2026-10-24", generated_at: "", odds: { fetched_at: null, plan: "free", props_priced: true },
      games: [{ game_id: 1, date: "2026-10-24", home: "NY", away: "BOS", time: "2026-10-24T23:30:00Z" }],
      rows: [at("1", 25.5, 21.5), at("2", 20, 19.5), at("3", 28, 21.5, { out: true }),
        at("4", 28, 21.5, { evidence: { ...nbaRow("4", 1, 1, 1).evidence, minutes_long: 12 } }),
        // a usual line, not one a book posted
        nbaRow("5", 1, 25.5, 21.5, { team: "T5" }),
        // questionable: not sure to play; probable is fine
        at("6", 25.5, 21.5, { injury: "Questionable" }), at("8", 25.5, 21.5, { injury: "Probable" }),
        // posted by other books but not DraftKings
        at("9", 25.5, 21.5, { offers: [{ book: "bovada", side: "over", line: 21.5, price: -110 }] }),
        // T10's fourth scorer is no star, however strong the lean
        at("10", 30, 26.5, { team: "T10" }), at("11", 29, 26.5, { team: "T10" }), at("12", 28, 26.5, { team: "T10" }), at("13", 25.5, 18.5, { team: "T10" }),
        // a bench player is no star either
        at("14", 25.5, 21.5, { evidence: { ...nbaRow("14", 1, 1, 1).evidence, start_rate: 0.1 } })] };
    const c = nbaCandidates(slate, { conf });
    // row 2 is a coin flip (an unproven tier), so it stays off even without a chance floor
    expect(c.map((p) => p.player_id)).toEqual(["1", "8", "10", "11", "12"]);
    expect(c[0].chance).toBeGreaterThanOrEqual(0.7);
    expect(c[0].tier).toBe("Strong");
    expect(c[0].sections.length).toBeGreaterThan(2);
    expect(c[0].kickoff).toBe("2026-10-24T23:30:00Z");
  });
});

describe("cfbCandidates", () => {
  const game = (o: Partial<CfbGame> = {}): CfbGame => ({
    game_id: 7, date: "2026-10-24T19:30:00Z", week: 8, season_type: "regular", home: "Alabama", away: "Kentucky", home_id: 1, away_id: 2,
    home_conf: "SEC", away_conf: "SEC", neutral: false, conference_game: true, venue: null, home_rank: null, away_rank: null, tv: null, featured: false,
    line: { spread: -14.5, total: 48.5, ml_home: -700, ml_away: 500, tt_home: 31.5, tt_away: 17, tt_posted: false, source: "9 sportsbooks", fetched_at: null, has_line: true },
    books: [], model: { home: 31, away: 17, margin: 14, total: 48, margin_q: [0, 14, 28], total_q: [35, 48, 61], home_win: 0.76, line_based: true },
    ratings: { home: { pts_for: null, ypp: null, plays: null, games: null }, away: { pts_for: null, ypp: null, plays: null, games: null } },
    markets: [], ...o,
  });
  const alt = (o: Partial<AltLine>): AltLine => ({ market: "spread", side: "home", line: -3.5, price: -350, book: "draftkings", chance: 0.86, implied: 0.78,
    tested_rate: 0.84, tested_n: 2600, tested_recent: 0.84, ...o });
  it("adds the likeliest alternate line that beats its price and tested well, over a less likely favorite", () => {
    const g = game({ alts: [alt({ price: -900, chance: 0.95, implied: 0.9 }), alt({}), alt({ line: -7.5, price: -250, chance: 0.8, implied: 0.71 }),
      alt({ market: "total", side: "over", line: 38.5, chance: 0.9, implied: 0.92, price: -500 })] });
    const c = cfbCandidates({ generated_at: "", games: [g], picks: [], odds: { books_games: 1, espn_games: 0, no_line: 0 } }, {});
    expect(c.map((p) => [p.bet, p.price, p.tier])).toEqual([["Alabama -3.5 (alt spread)", -350, "Alt line"]]);
    expect(grade(c[0], { cfb: { "7": [24, 20] } })?.result).toBe("won");
    // no alternate lines loaded: the favorite stands
    expect(cfbCandidates({ generated_at: "", games: [game()], picks: [], odds: { books_games: 1, espn_games: 0, no_line: 0 } }, {})[0].tier).toBe("Favorite");
  });
});

describe("picks of the day", () => {
  const now = new Date("2026-10-24T17:00:00Z");   // Saturday noon in Chicago
  const at = (i: number, o: Partial<LabPick> = {}) => pick({ id: `p${i}`, game_id: String(i), player_id: String(i), kickoff: "2026-10-25T00:00:00Z", chance: 0.9 - i / 100, ...o });
  it("locks each sport's 3 likeliest picks per Central-time day, priced -300 or longer at a book line, and never swaps them", () => {
    const cands = [at(1, { price: -350 }), at(0, { line_source: "usual" }), at(2), at(3), at(4), at(5),
      at(6, { kickoff: "2026-10-24T16:00:00Z" }),                    // already started
      at(7, { kickoff: "2026-10-26T00:00:00Z", chance: 0.99 }),      // Sunday evening in Chicago: tomorrow's list
      at(8, { kickoff: "2026-10-28T00:00:00Z", chance: 0.99 })];     // later in the week: not yet
    const d = chooseDaily([], cands, now);
    expect(d.filter((x) => x.date === "2026-10-24").map((x) => [x.id, x.slot])).toEqual([["p2", 1], ["p3", 2], ["p4", 3]]);
    expect(d.filter((x) => x.date === "2026-10-25").map((x) => x.id)).toEqual(["p7"]);
    // a later refresh with a likelier pick keeps today's three as chosen
    expect(chooseDaily(d, [...cands, at(9, { chance: 0.98 })], now).filter((x) => x.date === "2026-10-24").map((x) => x.id)).toEqual(["p2", "p3", "p4"]);
  });
  it("skips picks under 60% and withdraws a locked pick before kickoff once the model backs the other side", () => {
    const d = chooseDaily([], [at(1, { chance: 0.59 }), at(2, { chance: 0.61 })], now);
    expect(d.map((x) => x.id)).toEqual(["p2"]);
    const del = at(3, { market: "moneyline", side: "away", chance: 0.62 });
    const s = advance({ updated_at: null, board: [], frozen: [] }, [del], {}, now);
    const wku = at(4, { game_id: "3", player_id: "3", market: "moneyline", side: "home", chance: 0.58 });
    const s2 = advance(s, [wku], {}, new Date("2026-10-24T18:00:00Z"));
    const w = s2.daily!.find((x) => x.id === "p3")!;
    expect([w.result, w.withdrawn]).toEqual(["void", true]);
    // the final score never turns a withdrawn pick into a result
    const s3 = advance(s2, [], { nba: { rows: [{ date: "2026-10-24", game_id: 3, player_id: "3", market: "points", actual: 99 }], through: "2026-10-24" } },
      new Date("2026-10-25T15:00:00Z"));
    expect(s3.daily!.find((x) => x.id === "p3")!.result).toBe("void");
  });
  it("withdraws a locked pick under the 60% floor before kickoff, but never one already played", () => {
    const old = { ...at(5, { chance: 0.51 }), date: "2026-10-24", slot: 1, chosen_at: "2026-10-23T12:00:00Z" };
    const done = { ...at(6, { chance: 0.52, kickoff: "2026-10-23T23:00:00Z" }), date: "2026-10-23", slot: 1, chosen_at: "2026-10-22T12:00:00Z" };
    const s = advance({ updated_at: null, board: [], frozen: [], daily: [old, done] }, [], {}, now);
    expect(s.daily!.find((x) => x.id === "p5")!.withdrawn).toBe(true);
    expect(s.daily!.find((x) => x.id === "p6")!.withdrawn).toBeUndefined();
  });
  it("withdraws a locked pick priced shorter than the -300 cap before kickoff", () => {
    const old = { ...at(5, { price: -490 }), date: "2026-10-24", slot: 1, chosen_at: "2026-10-23T12:00:00Z" };
    const s = advance({ updated_at: null, board: [], frozen: [], daily: [old] }, [], {}, now);
    expect(s.daily!.find((x) => x.id === "p5")!.withdrawn).toBe(true);
  });
  it("grades picks of the day and keeps their own record", () => {
    const s = advance({ updated_at: null, board: [], frozen: [] }, [at(2, { game_id: "9", player_id: "5", side: "over", line: 20.5 })], {}, now);
    expect(s.daily?.length).toBe(1);
    const later = new Date("2026-10-25T15:00:00Z");
    const s2 = advance(s, [], { nba: { rows: [{ date: "2026-10-24", game_id: 9, player_id: "5", market: "points", actual: 25 }], through: "2026-10-24" } }, later);
    const b = publish(s2, sports);
    expect(b.daily.record.by_sport.nba.won).toBe(1);
    expect(b.daily.recent[0].result).toBe("won");
    expect(b.daily.today).toBe("2026-10-25");
  });
});

describe("records", () => {
  it("counts only book lines, and keeps units and ROI at the posted price", () => {
    const r = tally([
      pick({ id: "a", result: "won", price: -200 }), pick({ id: "b", result: "lost", price: -110 }),
      pick({ id: "c", result: "won", price: 150 }), pick({ id: "d", result: "won", price: null }),
      pick({ id: "e", result: "won", line_source: "usual" }), pick({ id: "f", result: "void" }),
    ]);
    expect([r.won, r.lost, r.void, r.unbooked, r.priced]).toEqual([3, 1, 1, 1, 3]);
    expect(r.units).toBe(1);   // +0.5 - 1 + 1.5
    expect(r.roi).toBeCloseTo(1 / 3);
  });
  it("keeps usual lines and prices shorter than -500 off the list", () => {
    const now = new Date("2026-10-24T17:00:00Z");
    const s = advance({ updated_at: null, board: [], frozen: [] }, [
      pick({ id: "a", game_id: "1", player_id: "1", kickoff: "2026-10-25T00:00:00Z", line_source: "usual" }),
      pick({ id: "b", game_id: "2", player_id: "2", kickoff: "2026-10-25T00:00:00Z", price: -900 }),
      pick({ id: "c", game_id: "3", player_id: "3", kickoff: "2026-10-25T00:00:00Z", price: -450 }),
    ], {}, now);
    expect(s.board.map((p) => p.id)).toEqual(["c"]);
  });
});
