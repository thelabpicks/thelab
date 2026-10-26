/* The Lab's picks: the strongest plays on the board across NFL, NBA and college football, ranked 1 to 10, each with
   its full write-up. Every pick comes from a sport's own proven pool (the same picks its home page and Ask show) and
   every number is one that sport published; this file only chooses, ranks, freezes and grades.
   The board is built by scripts/lab-picks.ts on each site refresh: a pick on the board when its game starts is
   frozen as shown and graded after the final, so the record is never written with hindsight. */
import { ALT_MIN_PRICE, altPool, anyPool, gameLabel, isProven, answerWhy, type AskData, type Pick } from "./ask";
import { easternToUtc } from "./static";
import { bestOffer, leanOf, marketLabel, MIN_LINE, nbaTier, type NbaRow, type Slate } from "./nba";
import type { AskContext as NbaCtx } from "./nbaAsk";
import { explainRow } from "./nbaAsk";
import { bookName as cfbBook, fmtPrice, pickText, tierOf, type Backtest, type CfbPick, type PropRow as CfbPropRow, type Team, type Week } from "./cfb";
import { isPick as cfbIsPick } from "./cfbAsk";
import { explainGame } from "./cfbExplain";
import { pct0, tidy, type Section } from "./writeup";

export type Sport = "nfl" | "nba" | "cfb";
export const SPORT_LABEL: Record<Sport, string> = { nfl: "NFL", nba: "NBA", cfb: "CFB" };
/** Each sport has its own top 10, in this order on the page. */
export const SPORTS: Sport[] = ["nfl", "cfb", "nba"];
export type LabResult = "won" | "lost" | "push" | "void";

export type LabPick = {
  id: string; sport: Sport; game_id: string; kickoff: string; matchup: string;
  /** "Jalen Brunson over 24.5 points", "Under 51.5", "Texas ML +135". */
  bet: string; who: string; player_id?: string; market: string; market_label: string;
  /** over / under / yes (anytime TD) / home / away (college sides). team_side: the team a college team total is on. */
  side: string; team_side?: "home" | "away"; line: number | null; line_source: "book" | "usual";
  price: number | null; book: string | null;
  /** The sport's own rating out of 10, as its pages show it. */
  score: number; chance: number;
  tier: string | null; tier_rate: number | null; tier_n: number | null;
  headline: string; sections: Section[]; link: string;
  rank?: number; frozen_at?: string; result?: LabResult; actual?: string;
};

/** Each sport lists its 10 likeliest picks; 70%+ is called out as a sure play. Picks are still limited to each
 *  sport's own pool (proven NFL and NBA tiers; college: favorites to win outright and bets rated 7+). */
export const SURE = 0.7;
export const BOARD_SIZE = 10;
const RISKY = new Set(["Questionable", "Doubtful", "Out"]);
const r1 = (v: number) => Math.round(v * 10) / 10;
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/* ------------------------------------------------------------------ NFL */

/** The NFL's proven picks (Strongest picks on the home page) plus alternate lines when the books' feed has them: one
 *  per player, tier proven on unseen weeks. */
export function nflCandidates(d: AskData): LabPick[] {
  const kick = new Map<string, string>();
  const status = new Map<string, string>();
  for (const r of d.td) {
    if (r.game_id && !kick.has(r.game_id)) { const k = easternToUtc(r.gameday, r.gametime); if (k) kick.set(r.game_id, k); }
    if (r.features?.report_status) status.set(r.player_id, String(r.features.report_status));
  }
  return [...anyPool(d), ...altPool(d)].filter((p) => isProven(d, p) && !RISKY.has(status.get(p.player_id) ?? "") && kick.has(p.game_id))
    .map((p) => nflPick(d, p, kick.get(p.game_id)!));
}

function nflPick(d: AskData, p: Pick, kickoff: string): LabPick {
  const why = answerWhy(d, [p.player_id], p.kind === "td" ? "td" : p.market, p.side === "yes" ? undefined : p.side);
  const x = why.picks?.find((y) => y.market === p.market) ?? p;
  const td = p.kind === "td";
  const bet = td ? `${p.name} to score a touchdown` : `${p.name} ${lc(p.label)}`;
  const usual = p.lineSource === "usual";
  const pick = [
    `${bet} (${p.team} vs ${p.opp}): ${pct0(p.p)} chance, ${r1(p.p * 10).toFixed(1)} out of 10.`,
    p.tierData?.rate != null ? `${p.tier} tier: ${p.tierData.hits.toLocaleString()} of ${p.tierData.n.toLocaleString()} past picks in that range hit (${pct0(p.tierData.rate)}) on weeks the model never saw.` : "",
    p.price != null && p.book ? `Best price ${fmtPrice(p.price)} at ${p.book}.` : usual ? "No book line is loaded yet, so this is his usual line; check your book's line before betting." : "",
  ];
  return {
    id: `nfl:${p.id}`, sport: "nfl", game_id: p.game_id, kickoff, matchup: gameLabel(p.game_id), bet, who: p.name, player_id: p.player_id,
    market: p.market, market_label: td ? "Anytime TD" : d.props[p.market]?.label ?? p.market, side: p.side, line: p.line ?? null,
    line_source: usual ? "usual" : "book", price: p.price ?? null, book: p.book ?? null, score: r1(p.p * 10), chance: p.p,
    tier: p.tier ?? null, tier_rate: p.tierData?.rate ?? null, tier_n: p.tierData?.n ?? null,
    headline: `The model gives ${p.name} a ${pct0(p.p)} chance${p.tierData?.rate != null ? `; ${p.tier} picks have hit ${pct0(p.tierData.rate)} on unseen weeks` : ""}.`,
    sections: tidy([
      { title: "The pick", lines: pick },
      { title: "Why it hits", lines: x.reasons ?? [] },
      ...(why.sections ?? []),
      { title: "Working against it", lines: x.against ?? [] },
    ]),
    link: `/players/${p.player_id}`,
  };
}

/* ------------------------------------------------------------------ NBA */

/** The NBA's strongest leans (the home page list): 20+ minute players not listed Out, proven tier, 6.0+. */
/** Without a book line, an NBA pick needs a player who starts most games and plays starter's minutes. */
export const NBA_MIN_START_RATE = 0.6;
export const NBA_MIN_MINUTES = 24;

export function nbaCandidates(slate: Slate, ctx: NbaCtx): LabPick[] {
  const games = new Map(slate.games.map((g) => [g.game_id, g]));
  const out: LabPick[] = [];
  for (const r of slate.rows) {
    if (r.out || r.evidence.minutes_long < 20 || r.line < MIN_LINE || !games.has(r.game_id)) continue;
    // Without a book line the line is the player's usual one. When this game's projection sits far from it (a role or
    // minutes change), no book will post that line, so a near-certain under against it is not a real pick.
    if (r.line_source !== "book" && Math.abs(r.mean - r.line) > Math.max(1.5, 0.2 * Math.max(r.line, r.mean))) continue;
    // Only players sure to play: anyone on the injury report (bar probable) is out of the list. Without a book line, only
    // regular starters with starter's minutes, the players books post props for.
    if (r.injury && !/probable/i.test(r.injury)) continue;
    if (r.line_source !== "book" && (r.evidence.start_rate < NBA_MIN_START_RATE || r.evidence.minutes < NBA_MIN_MINUTES)) continue;
    const lean = leanOf(r);
    if (!lean) continue;
    const t = nbaTier(ctx.conf, lean.p);
    if (!t || t.tier === "Coin flip" || t.rate == null || t.rate < 0.5) continue;
    out.push(nbaPick(r, lean.side, lean.p, t, games.get(r.game_id)!, ctx));
  }
  return out;
}

function nbaPick(r: NbaRow, side: "over" | "under", p: number, t: NonNullable<ReturnType<typeof nbaTier>>, g: Slate["games"][number], ctx: NbaCtx): LabPick {
  const off = bestOffer(r, side);
  const label = marketLabel(r.market);
  return {
    id: `nba:${r.game_id}:${r.player_id}:${r.market}`, sport: "nba", game_id: String(r.game_id), kickoff: g.time, matchup: `${g.away} at ${g.home}`,
    bet: `${r.player_name} ${side} ${r.line} ${label.toLowerCase()}`, who: r.player_name, player_id: r.player_id, market: r.market, market_label: label,
    side, line: r.line, line_source: r.line_source, price: off?.price ?? null, book: off ? cfbBook(off.book) : null,
    score: r1(p * 10), chance: p, tier: t.tier, tier_rate: t.rate, tier_n: t.n,
    headline: `Projects ${r.mean.toFixed(1)} against a line of ${r.line}; ${t.tier} leans have hit ${pct0(t.rate)} of ${t.n.toLocaleString()} unseen games.`,
    sections: explainRow(r, side, ctx), link: `/nba/players/${r.player_id}`,
  };
}

/* ------------------------------------------------------------------ college football */

export type CfbCtx = { teams?: Team[]; bt?: Backtest; props?: CfbPropRow[] };

/** College football's likeliest picks: per game, the higher chance of the model's favorite to win outright (5,000
 *  simulations) and the game's best bet when it rates 7+. Spreads and totals sit near 50/50 by design, so the
 *  favorites usually win out. */
export function cfbCandidates(week: Week, ctx: CfbCtx): LabPick[] {
  const best = new Map<number, LabPick>();
  const keep = (x: LabPick) => { const b = best.get(Number(x.game_id)); if (!b || x.chance > b.chance) best.set(Number(x.game_id), x); };
  for (const g of week.games) {
    const f = cfbFavorite(g, ctx); if (f) keep(f);
    const a = cfbAlt(g, ctx); if (a) keep(a);
  }
  for (const p of week.picks) {
    const g = week.games.find((x) => x.game_id === p.game_id);
    if (g && cfbIsPick(p)) keep(cfbPick(p, g, ctx));
  }
  return [...best.values()];
}

/** The model's favorite to win outright, at the best posted moneyline. The model's win chances are calibrated: the
 *  backtest's games are grouped by the underdog's chance, so the favorite's record is the rest of each group. */
function cfbFavorite(g: Week["games"][number], ctx: CfbCtx): LabPick | null {
  const home = g.model.home_win >= 0.5;
  const side = home ? "home" : "away", team = home ? g.home : g.away;
  const chance = home ? g.model.home_win : 1 - g.model.home_win;
  const offers = (g.books ?? []).map((b) => ({ book: b.book, price: b.ml?.[side]?.[1] })).filter((o): o is { book: string; price: number } => o.price != null);
  const top = offers.sort((a, b) => dec(b.price) - dec(a.price))[0];
  const price = top?.price ?? (home ? g.line.ml_home : g.line.ml_away);
  if (!g.line.has_line || price == null) return null;
  const bin = ctx.bt?.upsets?.calibration.find((c) => 1 - chance >= c.lo && 1 - chance < c.hi);
  const implied = 1 / dec(price);
  const bet = `${team} to win (ML ${fmtPrice(price)})`;
  return {
    id: `cfb:${g.game_id}:moneyline:${team}`, sport: "cfb", game_id: String(g.game_id), kickoff: g.date, matchup: `${g.away} at ${g.home}`,
    bet, who: team, market: "moneyline", market_label: "Moneyline", side, line: null, line_source: "book",
    price, book: top ? cfbBook(top.book) : null, score: r1(chance * 10), chance,
    tier: "Favorite", tier_rate: bin ? 1 - bin.actual : null, tier_n: bin?.n ?? null,
    headline: `${team} wins ${pct0(chance)} of 5,000 simulated games${bin ? `; favorites the model gave ${pct0(1 - bin.hi)}–${pct0(1 - bin.lo)} won ${pct0(1 - bin.actual)} of ${bin.n.toLocaleString()} past games` : ""}.`,
    sections: tidy([
      { title: "The pick", lines: [
        `${team} to win outright: ${pct0(chance)} of 5,000 simulated games.`,
        `Best price ${fmtPrice(price)}${top ? ` at ${cfbBook(top.book)}` : ""}, which implies ${pct0(implied)}. A favorite this big pays little: $100 returns ${(100 * (dec(price) - 1)).toFixed(0)} in profit.`,
        bin ? `In testing (${(bin.n).toLocaleString()} games where the model gave the underdog ${pct0(bin.lo)}–${pct0(bin.hi)}), the favorite won ${pct0(1 - bin.actual)}; the model had said ${pct0(1 - bin.model)}.` : "",
        "Moneyline favorites are a likely win, not a proven money-maker: the betting edge The Lab found in testing is on underdogs and totals.",
      ] },
      ...explainGame(g, ctx, {}),
    ]),
    link: `/cfb/game/${g.game_id}`,
  };
}
const dec = (american: number) => 1 + (american > 0 ? american / 100 : 100 / -american);
const altShifts = (ctx: CfbCtx) => { const s = ctx.bt?.alt_lines?.shifts ?? []; return s.length ? `${Math.min(...s)} to ${Math.max(...s)}` : "several"; };

/** The game's likeliest alternate spread or total: a line a book posts, priced -500 or longer, that the sims give a
 *  better chance than the price implies, and whose chance band held up at moved lines in testing (60%+ overall and
 *  over the last two seasons). */
function cfbAlt(g: Week["games"][number], ctx: CfbCtx): LabPick | null {
  const a = (g.alts ?? []).filter((x) => x.price >= ALT_MIN_PRICE && x.chance > x.implied && (x.tested_rate ?? 0) >= 0.6 && (x.tested_recent ?? 0) >= 0.6)
    .sort((x, y) => y.chance - x.chance)[0];
  if (!a) return null;
  const spread = a.market === "spread";
  const team = a.side === "home" ? g.home : g.away;
  const main = spread ? (g.line.spread == null ? null : a.side === "home" ? g.line.spread : -g.line.spread) : g.line.total;
  const sgn = (v: number) => (v > 0 ? `+${v}` : String(v));
  const bet = spread ? `${team} ${sgn(a.line)} (alt spread)` : `${a.side === "over" ? "Over" : "Under"} ${a.line} (alt total)`;
  const bins = ctx.bt?.alt_lines?.markets[a.market] ?? [];
  const bin = bins.find((b) => a.chance >= b.lo && a.chance < (b.hi < 1 ? b.hi : 2));
  const moved = main == null ? "" : spread ? ` instead of the main line ${sgn(main)}` : ` instead of the main total ${main}`;
  return {
    id: `cfb:${g.game_id}:alt:${a.market}:${a.side}:${a.line}`, sport: "cfb", game_id: String(g.game_id), kickoff: g.date, matchup: `${g.away} at ${g.home}`,
    bet, who: spread ? team : bet, market: a.market, market_label: spread ? "Alt spread" : "Alt total",
    side: a.side, line: a.line, line_source: "book", price: a.price, book: cfbBook(a.book),
    score: r1(a.chance * 10), chance: a.chance, tier: "Alt line", tier_rate: a.tested_rate, tier_n: a.tested_n,
    headline: `Hits in ${pct0(a.chance)} of 5,000 simulated games${moved}; sims at this chance hit ${pct0(a.tested_rate!)} of ${(a.tested_n ?? 0).toLocaleString()} tested lines.`,
    sections: tidy([
      { title: "The pick", lines: [
        `${bet}: ${pct0(a.chance)} of 5,000 simulated games${moved}.`,
        `Best price ${fmtPrice(a.price)} at ${cfbBook(a.book)}, which implies ${pct0(a.implied)}; the sims make it ${pct0(a.chance)}. $100 returns ${(100 * (dec(a.price) - 1)).toFixed(0)} in profit.`,
        bin ? `In testing, closing ${spread ? "spreads" : "totals"} were moved ${altShifts(ctx)} points toward the model's side and priced by the sims: lines given ${pct0(bin.lo)}–${pct0(Math.min(bin.hi, 1))} hit ${pct0(bin.rate!)} of ${bin.n.toLocaleString()}${bin.recent_rate != null ? ` (${pct0(bin.recent_rate)} over the last two seasons)` : ""}. Past alternate prices are not archived, so this tests the chance, not the return.` : "",
      ] },
      ...explainGame(g, ctx, { market: a.market }),
    ]),
    link: `/cfb/game/${g.game_id}`,
  };
}

function cfbPick(p: CfbPick, g: Week["games"][number], ctx: CfbCtx): LabPick {
  const t = tierOf(ctx.bt?.markets[p.market], p.tier);
  // 7, 8 and 9 did not separate in testing, so the headline quotes the whole 7+ band (each band is in the write-up)
  const top = ctx.bt?.rating?.bands.filter((b) => b.lo >= 7 && b.roi != null && b.n) ?? [];
  const n7 = top.reduce((a, b) => a + b.n, 0);
  const roi7 = n7 ? top.reduce((a, b) => a + b.n * (b.roi as number), 0) / n7 : null;
  const chance = p.fair_p ?? p.p;
  const bet = pickText(p);
  return {
    id: `cfb:${p.game_id}:${p.market}:${p.team ?? p.side}`, sport: "cfb", game_id: String(p.game_id), kickoff: p.date, matchup: `${g.away} at ${g.home}`,
    bet, who: p.team ?? bet, market: p.market, market_label: { spread: "Spread", total: "Game total", team_total: "Team total", moneyline: "Moneyline" }[p.market],
    side: p.side, team_side: p.team_side, line: p.line ?? null, line_source: p.market === "team_total" && !p.line_posted ? "usual" : "book",
    price: p.best?.price ?? p.price ?? null, book: p.best?.book ? cfbBook(p.best.book) : null,
    score: r1(p.score), chance, tier: p.tier, tier_rate: t?.rate ?? null, tier_n: t?.n ?? null,
    headline: `${pct0(chance)} chance after calibration, rated ${p.score.toFixed(1)} out of 10${roi7 != null ? `; bets rated 7+ returned ${roi7 >= 0 ? "+" : "−"}${Math.abs(roi7 * 100).toFixed(1)}% per bet over ${n7.toLocaleString()} tested bets` : ""}.`,
    sections: explainGame(g, ctx, { market: p.market, upset: p.market === "moneyline" }), link: `/cfb/game/${p.game_id}`,
  };
}

/* ------------------------------------------------------------------ ranking */

/** Best first: the chance it hits (simulated and calibrated on past results), then a real book line over a usual one,
 *  then how the pick's tier did in testing. */
export function byStrength(a: LabPick, b: LabPick): number {
  return b.chance - a.chance || Number(a.line_source === "usual") - Number(b.line_source === "usual")
    || (b.tier_rate ?? 0) - (a.tier_rate ?? 0) || b.score - a.score;
}

/** One sport's top picks, one per game and one per player, numbered 1 (most likely to hit) down. Fewer than n when fewer qualify. */
export function rankBoard(cands: LabPick[], n = BOARD_SIZE): LabPick[] {
  const games = new Set<string>(), players = new Set<string>();
  const out: LabPick[] = [];
  for (const c of [...cands].sort(byStrength)) {
    const g = `${c.sport}:${c.game_id}`, pl = c.player_id ? `${c.sport}:${c.player_id}` : "";
    if (games.has(g) || (pl && players.has(pl))) continue;
    games.add(g);
    if (pl) players.add(pl);
    out.push({ ...c, rank: out.length + 1 });
    if (out.length === n) break;
  }
  return out;
}

/* ------------------------------------------------------------------ grading */

export type NflSettled = { game_id: string; player_id: string; market: string; status: "graded" | "void"; actual: number | null };
export type NbaGraded = { date: string; game_id: number; player_id: string; market: string; actual: number };
export type Results = { nfl?: NflSettled[]; nba?: { rows: NbaGraded[]; through: string | null }; cfb?: Record<string, [number, number]> };

const vsLine = (v: number, line: number, side: string): LabResult => (v === line ? "push" : (v > line) === (side === "over") ? "won" : "lost");
const n1 = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Grade one frozen pick at the line it was frozen with, from the sport's own graded results. Null while pending. */
export function grade(p: LabPick, res: Results): { result: LabResult; actual: string } | null {
  if (p.sport === "nfl") {
    const r = res.nfl?.find((x) => x.game_id === p.game_id && x.player_id === p.player_id && x.market === p.market);
    if (!r) return null;
    if (r.status === "void" || r.actual == null) return { result: "void", actual: "Did not play" };
    if (p.market === "td") return { result: r.actual ? "won" : "lost", actual: r.actual ? "Scored" : "No touchdown" };
    return { result: vsLine(r.actual, p.line!, p.side), actual: `Finished with ${n1(r.actual)}` };
  }
  if (p.sport === "nba") {
    const r = res.nba?.rows.find((x) => String(x.game_id) === p.game_id && x.player_id === p.player_id && x.market === p.market);
    if (r) return { result: vsLine(r.actual, p.line!, p.side), actual: `Finished with ${n1(r.actual)}` };
    // graded days after this game with no box-score row for him: he did not play
    const day = new Date(p.kickoff).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    return res.nba?.through && res.nba.through > day ? { result: "void", actual: "Did not play" } : null;
  }
  const f = res.cfb?.[p.game_id];
  if (!f) return null;
  const [hp, ap] = f;
  const score = `Final ${ap}–${hp}`;
  if (p.market === "total") return { result: vsLine(hp + ap, p.line!, p.side), actual: `${score} (${hp + ap} total)` };
  if (p.market === "team_total") return { result: vsLine(p.team_side === "home" ? hp : ap, p.line!, p.side), actual: score };
  const margin = p.side === "home" ? hp - ap : ap - hp;
  if (p.market === "moneyline") return { result: margin > 0 ? "won" : "lost", actual: score };
  const cover = margin + (p.line ?? 0);
  return { result: cover === 0 ? "push" : cover > 0 ? "won" : "lost", actual: score };
}

/* ------------------------------------------------------------------ the weekly state */

/** A pick of the day: locked once chosen, graded after the final, never swapped. */
export type DailyPick = LabPick & { date: string; slot: number; chosen_at: string };
export type LabState = { updated_at: string | null; board: LabPick[]; frozen: LabPick[]; daily?: DailyPick[] };
export type LabRecord = { n: number; won: number; lost: number; push: number; void: number; rate: number | null };
export type LabBoard = {
  /** Every sport's top 10 together; rank is within the pick's sport. notes: why a sport's list is short. */
  generated_at: string; board: LabPick[]; notes: Record<Sport, string | null>;
  sports: Record<Sport, { loaded: boolean; candidates: number }>;
  record: LabRecord & { by_sport: Record<Sport, LabRecord>; since: string | null };
  recent: LabPick[];
  /** Each sport's top 3 picks of the day (Central time): today's and tomorrow's once chosen, the recent ones, and their own record. */
  daily: { today: string; picks: DailyPick[]; recent: DailyPick[]; record: LabRecord & { by_sport: Record<Sport, LabRecord> } };
};

/** Picks of the day per sport. In testing the model's top 3 per NFL day hit about 85% (props at lines near the
 *  projection, 2021-2026) and its top 3 college favorites per Saturday hit about 88% when priced -1000 or longer
 *  (2016-2026); with no price limit they hit 96% but at -5000 and shorter, which pays nothing. */
export const DAILY_SIZE = 3;
export const DAILY_MIN_PRICE = -1000;
const DAILY_KEEP_DAYS = 90;
/** The Central-time date a game is played on: picks of the day follow the US sports day, not UTC. */
export const playDate = (iso: string | Date) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/** Fills today's and tomorrow's open pick-of-the-day slots for each sport with its likeliest picks on that date (same
 *  ranking and one-per-game/player rule as the top 10; games not yet started; priced DAILY_MIN_PRICE or longer when a
 *  price is known). Slots already filled stay exactly as chosen. */
export function chooseDaily(prev: DailyPick[], open: LabPick[], now: Date): DailyPick[] {
  const today = playDate(now), tomorrow = playDate(new Date(now.getTime() + 864e5));
  const out = [...prev];
  for (const sp of SPORTS) {
    for (const date of [today, tomorrow]) {
      const have = out.filter((d) => d.sport === sp && d.date === date);
      if (have.length >= DAILY_SIZE) continue;
      const games = new Set(have.map((d) => d.game_id)), players = new Set(have.map((d) => d.player_id).filter(Boolean));
      const pool = open.filter((p) => p.sport === sp && playDate(p.kickoff) === date && new Date(p.kickoff) > now
        && (p.price == null || p.price >= DAILY_MIN_PRICE) && !games.has(p.game_id) && !(p.player_id && players.has(p.player_id)));
      rankBoard(pool, DAILY_SIZE - have.length).forEach((p, i) => {
        const { frozen_at: _f, ...rest } = p;
        out.push({ ...rest, date, slot: have.length + i + 1, chosen_at: now.toISOString() });
      });
    }
  }
  return out;
}

/** Picks from the last board whose games have started are frozen as they were shown; the rest are rebuilt. */
export function advance(prev: LabState, cands: LabPick[], res: Results, now: Date): LabState {
  const at = prev.updated_at ?? now.toISOString();
  const started = (p: LabPick) => new Date(p.kickoff) <= now;
  const known = new Set(prev.frozen.map((p) => p.id));
  const frozen = [...prev.frozen, ...prev.board.filter((p) => started(p) && !known.has(p.id)).map((p) => ({ ...p, frozen_at: at }))]
    .map((p) => { if (p.result && p.result !== "void") return p; const g = grade(p, res); return g ? { ...p, ...g } : p; });
  const open = cands.filter((c) => !started(c));
  const board = SPORTS.flatMap((sp) => rankBoard(open.filter((c) => c.sport === sp)));
  const cutoff = playDate(new Date(now.getTime() - DAILY_KEEP_DAYS * 864e5));
  const daily = chooseDaily((prev.daily ?? []).filter((d) => d.date >= cutoff), open, now)
    .map((d) => { if (d.result && d.result !== "void") return d; const g = grade(d, res); return g ? { ...d, ...g } : d; });
  return { updated_at: now.toISOString(), board, frozen, daily };
}

export function tally(ps: LabPick[]): LabRecord {
  const c = (r: LabResult) => ps.filter((p) => p.result === r).length;
  const won = c("won"), lost = c("lost");
  return { n: won + lost, won, lost, push: c("push"), void: c("void"), rate: won + lost ? won / (won + lost) : null };
}

export function publish(s: LabState, sports: LabBoard["sports"], recentN = 60): LabBoard {
  const settled = s.frozen.filter((p) => p.result);
  const by = Object.fromEntries(SPORTS.map((sp) => [sp, tally(settled.filter((p) => p.sport === sp))])) as Record<Sport, LabRecord>;
  const note = (sp: Sport) => {
    const n = s.board.filter((p) => p.sport === sp).length;
    // candidates counts qualifying picks before started games are dropped: some, but none left, means they have all started
    return n >= BOARD_SIZE ? null : !n && sports[sp]?.candidates ? "Every pick that qualified has already started. The next list posts with this sport's next refresh."
      : !n ? "No games with posted lines are left on the board right now."
      : `Only ${n} ${n === 1 ? "pick is" : "picks are"} on the board right now (one per game and per player, from games that have not started).`;
  };
  return {
    generated_at: s.updated_at ?? new Date().toISOString(), board: s.board, sports,
    notes: Object.fromEntries(SPORTS.map((sp) => [sp, note(sp)])) as Record<Sport, string | null>,
    record: { ...tally(settled), by_sport: by, since: s.frozen.length ? s.frozen.map((p) => p.kickoff).sort()[0] : null },
    recent: SPORTS.flatMap((sp) => s.frozen.filter((p) => p.sport === sp).sort((a, b) => b.kickoff.localeCompare(a.kickoff)).slice(0, recentN)),
    daily: dailyBoard(s),
  };
}

function dailyBoard(s: LabState) {
  const today = playDate(s.updated_at ?? new Date());
  const all = s.daily ?? [];
  const settled = all.filter((d) => d.result);
  const order = (a: DailyPick, b: DailyPick) => SPORTS.indexOf(a.sport) - SPORTS.indexOf(b.sport) || a.slot - b.slot;
  return {
    today, picks: all.filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date) || order(a, b)),
    recent: all.filter((d) => d.date < today).sort((a, b) => b.date.localeCompare(a.date) || order(a, b)).slice(0, 45),
    record: { ...tally(settled), by_sport: Object.fromEntries(SPORTS.map((sp) => [sp, tally(settled.filter((d) => d.sport === sp))])) as Record<Sport, LabRecord> },
  };
}
