/* The "Ask" engine: answers betting questions from the site's own validated numbers. Every chance, line and price
   in an answer comes from the published data (rankings, prop projections, sportsbook feed); nothing is invented.
   The same functions back the optional AI mode, which may only call them as tools. */
import type { Confidence, Tier } from "@/lib/confidence";
import { PROVEN_NOTE, proven, tierFor } from "@/lib/confidence";
import type { Feed, OddsRow } from "@/lib/feed";
import { feedLine } from "@/lib/feed";
import { pOver, type PropDist } from "@/lib/props";
import { simulate, type Buckets, type SimLeg } from "@/lib/sim";
import type { RankingRow } from "@/lib/types";
import { dueOf, type Due, type DueBin } from "@/lib/signals";
import { likelyToPlay, starterQbs } from "@/lib/playing";
import { bookLines, ladder, lineAtRate, playable } from "@/lib/hitrates";
import { tidy, type Section } from "@/lib/writeup";

export type Recent = { season: number; week: number; opponent: string; value: number };
export type PropRow = { player_id: string; player_name: string; team: string; opponent: string; position: string; game_id: string; eligible: number;
  median: number; q10: number; q90: number; dist: PropDist | null; recent?: Recent[]; evidence?: Record<string, number | null> };
/** One defense from /defenses (games before this week only), with its scheme rates when charting is built. */
export type AskDefense = {
  defense: string; games: number; available: boolean; positions: Record<string, { tds: number; tds_pg: number; xtd_pg: number }>;
  points_allowed_pg: number | null; offensive_tds_allowed_pg: number; xtd_allowed_pg: number; rz_td_rate_allowed: number | null; plays_faced_pg: number | null;
  scheme?: { rates: Record<string, number>; top_shell: [string | null, number | null] | null };
};
type Pos = "QB" | "RB" | "WR" | "TE";
export type AskDefenses = { teams: AskDefense[]; league: Partial<Record<Pos, { tds_pg: number; xtd_pg: number }>> & { rz_td_rate?: number | null };
  scheme_league?: Record<string, number> | null; coverage?: string };
export type AskData = {
  season: number; week: number; td: RankingRow[]; props: Record<string, { label: string; rows: PropRow[] }>;
  feed: Feed; conf?: Confidence; buckets: Buckets; useCorr: boolean; dueRecord?: DueBin | null; defenses?: AskDefenses | null;
};
export type Pick = {
  id: string; player_id: string; name: string; team: string; opp: string; pos: string; game_id: string; market: string; label: string;
  p: number; kind: "td" | "props"; side: "yes" | "over" | "under"; line?: number; price?: number; book?: string; edge?: number;
  tier?: string; tierRate?: number | null; tierData?: Tier; note?: string; reasons?: string[]; lineSource?: "book" | "usual"; median?: number; range?: [number, number]; dist?: PropDist; recent?: Recent[]; due?: Due; against?: string[]; facts?: string[];
};
export type Answer = {
  title: string; summary: string; picks?: Pick[]; groups?: { title: string; picks: Pick[] }[];
  parlay?: { joint: number; independent: number; price?: number; legs: number }; notes: string[]; followups: string[];
  projections?: { name: string; team: string; pos: string; market: string; median: number; range: [number, number] }[];
  table?: { columns: string[]; rows: (string | number)[][] };
  /** A detailed write-up for "why" questions. */
  sections?: Section[];
};

const MIN_EDGE = 0.03;
const RISKY = new Set(["Questionable", "Doubtful", "Out"]);

/* ------------------------------------------------------------------ vocabulary */
export const TEAMS: Record<string, string> = {
  cardinals: "ARI", arizona: "ARI", falcons: "ATL", atlanta: "ATL", ravens: "BAL", baltimore: "BAL", bills: "BUF", buffalo: "BUF",
  panthers: "CAR", carolina: "CAR", bears: "CHI", chicago: "CHI", bengals: "CIN", cincinnati: "CIN", browns: "CLE", cleveland: "CLE",
  cowboys: "DAL", dallas: "DAL", broncos: "DEN", denver: "DEN", lions: "DET", detroit: "DET", packers: "GB", "green bay": "GB",
  texans: "HOU", houston: "HOU", colts: "IND", indianapolis: "IND", jaguars: "JAX", jags: "JAX", jacksonville: "JAX", chiefs: "KC",
  "kansas city": "KC", rams: "LA", chargers: "LAC", raiders: "LV", "las vegas": "LV", vegas: "LV", dolphins: "MIA", miami: "MIA",
  vikings: "MIN", minnesota: "MIN", patriots: "NE", pats: "NE", "new england": "NE", saints: "NO", "new orleans": "NO", giants: "NYG",
  jets: "NYJ", eagles: "PHI", philadelphia: "PHI", philly: "PHI", steelers: "PIT", pittsburgh: "PIT", seahawks: "SEA", seattle: "SEA",
  "49ers": "SF", niners: "SF", "san francisco": "SF", buccaneers: "TB", bucs: "TB", "tampa bay": "TB", tampa: "TB", titans: "TEN",
  tennessee: "TEN", commanders: "WAS", washington: "WAS",
};
const CODES = new Set(Object.values(TEAMS));
const POS: [RegExp, string][] = [
  [/\b(qbs?|quarterbacks?)\b/, "QB"], [/\b(rbs?|running ?backs?|backs|rushers?)\b/, "RB"],
  [/\b(wrs?|wide ?receivers?|receivers?|wideouts?)\b/, "WR"], [/\b(tes?|tight ?ends?)\b/, "TE"],
];
// market -> phrases (longest first matters for overlaps like "rushing + receiving yards")
const MARKET_WORDS: [string, RegExp][] = [
  ["rush_rec_yards", /(rush(ing)?\s*(\+|and|&)\s*rec(eiving)?|scrimmage)\s*(yards|yds)?/],
  ["rec_yards", /(rec(eiving)?|catch(ing)?)\s*(yards|yds|yardage)/],
  ["rush_yards", /(rush(ing)?|run(ning)?|ground)\s*(yards|yds|yardage)/],
  ["pass_yards", /(pass(ing)?|throw(ing)?|air)\s*(yards|yds|yardage)/],
  ["pass_tds", /(pass(ing)?|throw(ing)?)\s*(tds?|touchdowns?)/],
  ["interceptions", /\b(interceptions?|ints?|picks thrown|throw a pick)\b/],
  ["completions", /\bcompletions?\b/],
  ["carries", /\b(carries|rush(ing)? attempts?|rushes)\b/],
  ["pass_attempts", /\b(pass(ing)? attempts?|attempts)\b/],
  ["receptions", /\b(receptions?|catches|recs)\b/],
];
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, single: 1,
  pair: 2, couple: 2, few: 3, handful: 5, dozen: 12 };
const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, tnf: 4, mnf: 1, snf: 0 };

/** Market label inside a sentence: lower case, but keep "TDs" as written. */
const lc = (s: string) => s.toLowerCase().replace(/\btds?\b/g, (m) => m.toUpperCase().replace("S", "s"));

export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9+&'. ]/g, " ")
  .replace(/(?<!\d)\.|\.(?!\d)/g, " ").replace(/'/g, "").replace(/\s+/g, " ").trim(); // keeps decimal points (6.5), drops the rest

/* ------------------------------------------------------------------ helpers */
const dec = (american: number) => 1 + (american > 0 ? american / 100 : 100 / -american);
const bestOf = (rows: OddsRow[]) => rows.reduce<OddsRow | null>((b, r) => (!b || dec(r.price) > dec(b.price) ? r : b), null);
export const american = (d: number) => (d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`);
export const fmtPrice = (p: number) => (p > 0 ? `+${p}` : String(p));
const pct = (p: number) => `${Math.round(p * 100)}%`;
export const gameTeams = (gid: string) => { const m = gid.split("_"); return { away: m[2] ?? "", home: m[3] ?? "" }; };
export const gameLabel = (gid: string) => { const g = gameTeams(gid); return `${g.away} at ${g.home}`; };
const status = (r: RankingRow) => (r.features?.report_status ? String(r.features.report_status) : "");

function withTier(d: AskData, p: Pick): Pick {
  const t = p.kind === "props" && p.p < 0.5 ? null : tierFor(d.conf, p.kind, p.p); // a prop side under 50% is the side we lean against: no tier
  return { ...p, tier: t?.tier, tierRate: t?.rate ?? null, tierData: t ?? undefined };
}

export function tdPick(d: AskData, r: RankingRow): Pick {
  const b = bestOf(d.feed.get("td", r.player_id, "yes"));
  const st = status(r);
  return withTier(d, {
    id: `td:${r.player_id}`, player_id: r.player_id, name: r.player_name, team: r.team, opp: r.opponent ?? "", pos: r.position,
    game_id: r.game_id ?? "", market: "td", label: "Anytime TD", p: r.p_model as number, kind: "td", side: "yes",
    price: b?.price, book: b?.book, edge: b ? (r.p_model as number) - 1 / dec(b.price) : undefined,
    note: st ? `Injury report: ${st}` : undefined, due: dueOf(r.features) ?? undefined,
  });
}

function propPick(d: AskData, market: string, r: PropRow, line: number, side: "over" | "under"): Pick {
  const over = pOver(r.dist as PropDist, line);
  const p = side === "over" ? over : 1 - over;
  const b = bestOf(d.feed.get(market, r.player_id, side).filter((x) => x.line === line));
  const label = `${side === "over" ? "Over" : "Under"} ${line} ${lc(d.props[market]?.label ?? market)}`;
  return withTier(d, {
    id: `${market}:${r.player_id}`, player_id: r.player_id, name: r.player_name, team: r.team, opp: r.opponent, pos: r.position, game_id: r.game_id,
    market, label, p, kind: "props", side, line, price: b?.price, book: b?.book, edge: b ? p - 1 / dec(b.price) : undefined,
    median: r.median, range: [r.q10, r.q90], dist: r.dist ?? undefined, recent: r.recent,
  });
}

/* ------------------------------------------------------------------ who plays */
const qbCache = new WeakMap<object, Map<string, string>>();
function qbs(d: AskData) {
  let m = qbCache.get(d.props);
  if (!m) { m = starterQbs(Object.values(d.props).flatMap((x) => x.rows)); qbCache.set(d.props, m); }
  return m;
}
const tdPricedGames = new WeakMap<object, Set<string>>();
function pricedGames(d: AskData) {
  let g = tdPricedGames.get(d.td);
  if (!g) { g = new Set(d.td.filter((r) => r.game_id && d.feed.get("td", r.player_id, "yes").length).map((r) => r.game_id as string)); tdPricedGames.set(d.td, g); }
  return g;
}
/** Projected starter or real role, and (once books have priced his game) listed by at least one book. */
export function plays(d: AskData, r: { player_id: string; team: string; position: string; game_id?: string | null }, snap: unknown, market = "td"): boolean {
  if (!likelyToPlay({ ...r, snap: typeof snap === "number" ? snap : null }, qbs(d))) return false;
  if (market === "td" && d.feed.at && r.game_id && pricedGames(d).has(r.game_id) && !d.feed.get("td", r.player_id, "yes").length) return false;
  return true;
}
const propPlays = (d: AskData, r: PropRow, m: string) => plays(d, r, r.evidence?.snap_pct, m);

/* ------------------------------------------------------------------ filters */
export type Filters = { position?: string; teams?: string[]; teamOnly?: boolean; day?: number; safe?: boolean };

function dayOf(r: { gameday?: string | null }) {
  return r.gameday ? new Date(`${r.gameday}T12:00:00`).getDay() : null;
}
function gameDays(d: AskData): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const r of d.td) if (r.game_id && !m.has(r.game_id)) m.set(r.game_id, dayOf(r));
  return m;
}
function keep(d: AskData, f: Filters, x: { pos: string; team: string; opp: string; game_id: string }, st = "") {
  if (f.position && x.pos !== f.position) return false;
  if (f.teams?.length && !f.teams.some((t) => t === x.team || (!f.teamOnly && t === x.opp))) return false;
  if (f.day != null && gameDays(d).get(x.game_id) !== f.day) return false;
  if (f.safe !== false && RISKY.has(st)) return false;
  return true;
}

export function tdPool(d: AskData, f: Filters = {}): Pick[] {
  return d.td.filter((r) => r.p_model != null && r.game_id && r.eligible !== false && plays(d, r, r.features?.snap_pct))
    .filter((r) => keep(d, f, { pos: r.position, team: r.team, opp: r.opponent ?? "", game_id: r.game_id ?? "" }, status(r)))
    .map((r) => tdPick(d, r)).sort((a, b) => b.p - a.p);
}

/** Every prop leg with a book line (the most common line across books), both sides. */
export function propPool(d: AskData, market: string, f: Filters = {}, side?: "over" | "under", customLine?: number): Pick[] {
  const out: Pick[] = [];
  for (const r of d.props[market]?.rows ?? []) {
    if (!r.eligible || !r.dist || !propPlays(d, r, market)) continue;
    if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
    const line = customLine ?? feedLine(d.feed, market, r.player_id);
    if (line == null) continue;
    for (const s of side ? [side] : (["over", "under"] as const)) out.push(propPick(d, market, r, line, s));
  }
  return out.sort((a, b) => b.p - a.p);
}

/** The single most likely leg for each player across every market: anytime TD plus the likelier side of each prop.
 *  Props use the book line once prices are loaded; before that, the player's usual line (marked as such). */
export function anyPool(d: AskData, f: Filters = {}, markets?: string[], onePerPlayer = true): Pick[] {
  const all: Pick[] = [];
  if (!markets || markets.includes("td")) all.push(...tdPool(d, f));
  const priced = !!d.feed.at;
  for (const m of markets?.filter((x) => x !== "td") ?? Object.keys(d.props)) {
    for (const r of d.props[m]?.rows ?? []) {
      if (!r.eligible || !r.dist || !propPlays(d, r, m)) continue;
      if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
      const book = feedLine(d.feed, m, r.player_id);
      const line = book ?? (priced ? null : usualLine(r, m));
      if (line == null) continue;
      // Books set lines near the projection. A usual line far from this week's projection (a role change, a backup
      // starting) is not a line anyone will offer, so it can't count as a "safe" pick.
      if (book == null && Math.abs(r.median - line) > Math.max(1.5, 0.2 * Math.max(line, r.median))) continue;
      const over = pOver(r.dist, line);
      all.push({ ...propPick(d, m, r, line, over >= 0.5 ? "over" : "under"), lineSource: book != null ? "book" : "usual" });
    }
  }
  all.sort((a, b) => b.p - a.p);
  if (!onePerPlayer) return all;
  const best = new Map<string, Pick>();
  for (const p of all) if (!best.has(p.player_id)) best.set(p.player_id, p);
  return [...best.values()];
}

/** Suggestions only use legs from tiers that proved 50%+ on unseen weeks. */
export const isProven = (d: AskData, p: Pick) => proven(d.conf, p.kind, p.p);

/** Shortest alternate-line price taken: past -500 the line pays too little to be worth buying it down. */
export const ALT_MIN_PRICE = -500;

/** Each player's likeliest alternate line (paid odds plan only): a line a book posts as an alternate, priced -500 or
 *  longer, that the model gives a better chance than the price implies. Lines come only from the books' feed. */
export function altPool(d: AskData, f: Filters = {}): Pick[] {
  const best = new Map<string, Pick>();
  for (const m of Object.keys(d.props)) {
    for (const r of d.props[m]?.rows ?? []) {
      if (!r.eligible || !r.dist || !propPlays(d, r, m)) continue;
      if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
      for (const side of ["over", "under"] as const) {
        for (const o of d.feed.get(m, r.player_id, side)) {
          if (!o.alt || o.line == null || o.price < ALT_MIN_PRICE) continue;
          const p = propPick(d, m, r, o.line, side);
          if (p.price == null || p.p <= 1 / dec(p.price)) continue;
          const alt = { ...p, id: `${p.id}:alt:${side}:${o.line}`, label: `${p.label} (alt line)`, lineSource: "book" as const };
          const b = best.get(r.player_id);
          if (!b || alt.p > b.p) best.set(r.player_id, alt);
        }
      }
    }
  }
  return [...best.values()].sort((a, b) => b.p - a.p);
}

/** A pick as a parlay-builder slip leg, with every loaded book price for that exact side and line. */
export function slipLeg(d: AskData, p: Pick) {
  const prices: Record<string, string> = {};
  for (const r of d.feed.get(p.market, p.player_id, p.side)) if (p.market === "td" || r.line === p.line) prices[r.book] = fmtPrice(r.price);
  return { id: p.id, market: p.market, player_id: p.player_id, team: p.team, position: p.pos, game_id: p.game_id, p: p.p, side: p.side, name: p.name,
    opponent: p.opp, label: p.market === "td" ? "Anytime TD" : d.props[p.market]?.label ?? p.market, line: p.line, dist: p.dist, recent: p.recent, prices };
}

export function answerAny(d: AskData, n: number, f: Filters, noTd = false): Answer {
  const picks = anyPool(d, f, noTd ? Object.keys(d.props) : undefined).filter((p) => isProven(d, p)).slice(0, n);
  if (!picks.length) return none(d, "No proven picks match that", f);
  const usual = picks.some((p) => p.lineSource === "usual");
  return {
    title: `${picks.length === 1 ? "Safest pick" : `Safest ${picks.length} picks`} across every market${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: `The highest validated chance for each player across ${noTd ? "every prop market (no TDs)" : "anytime TD and every prop market"}, one pick per player.`,
    picks, notes: [
      ...(usual ? ["No book lines are loaded yet, so props are shown at each player's usual line (his recent median, rounded to a half point), and only where that line is close to this week's projection. Books may still set a different line, so check it before betting."] : []),
      PROVEN_NOTE, ...noteTier(picks), ...priceNote(d)],
    followups: ["Build a 3-leg parlay from these", "Best value bets", "Who will fall short this week?"],
  };
}

/* ------------------------------------------------------------------ answers (also the AI tools) */
const describe = (f: Filters) => [f.position ? `${f.position}s` : "", f.teams?.length ? f.teams.join("/") : "",
  f.day != null ? Object.keys(DAYS).find((k) => DAYS[k] === f.day && k.length > 3) ?? "" : ""].filter(Boolean).join(", ");

function noteTier(picks: Pick[]): string[] {
  return picks.some((p) => p.tier) ? ["Tiers show how often past picks in that range actually hit on unseen weeks (walk-forward, 2021–2026)."] : [];
}
const priceNote = (d: AskData) => (d.feed.at ? [] : ["No sportsbook prices are loaded for this week yet, so value and price comparisons are not available."]);

export function answerTop(d: AskData, n: number, f: Filters): Answer {
  const picks = tdPool(d, f).slice(0, n);
  if (!picks.length) return none(d, "No anytime-TD chances match that", f);
  return {
    title: `Top ${picks.length} anytime TD ${picks.length === 1 ? "pick" : "picks"}${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: `Highest validated chances to score this week${f.safe !== false ? ", leaving out players listed Questionable or worse" : ""}.`,
    picks, notes: [...noteTier(picks), ...priceNote(d)],
    followups: ["Build a 3-leg parlay from these", "Best value TD bets", "One TD scorer from each game"],
  };
}

export function answerPerGame(d: AskData, market: string, f: Filters): Answer {
  const pool = (market === "any" ? anyPool(d, f) : market === "any-props" ? anyPool(d, f, Object.keys(d.props)) : market === "td" ? tdPool(d, f) : propPool(d, market, f))
    .filter((p) => isProven(d, p));
  const byGame = new Map<string, Pick>();
  for (const p of pool) if (!byGame.has(p.game_id)) byGame.set(p.game_id, p);
  const picks = [...byGame.values()].sort((a, b) => b.p - a.p);
  if (!picks.length) return none(d, market === "td" ? "No TD chances for these games" : `No ${(d.props[market] && lc(d.props[market].label)) ?? market} lines yet`, f);
  const sim = simulate(picks.map(toSim), d.buckets, d.useCorr, 20000);
  const what = market === "any" ? "pick (any market)" : market === "any-props" ? "prop (any market, no TDs)" : market === "td" ? "TD scorer" : `${(d.props[market] && lc(d.props[market].label))} pick`;
  return {
    title: `Best ${what} from each game${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: `The single most likely ${market === "td" ? "scorer" : market === "any" ? "leg across TD and every prop market" : market === "any-props" ? "leg across every prop market" : "leg"} in each of ${picks.length} games, strongest first.`,
    picks, notes: [
      `Chance at least ${Math.ceil(picks.length / 2)} of ${picks.length} hit: ${pct(sim.hits.slice(Math.ceil(picks.length / 2)).reduce((a, b) => a + b, 0))}. ` +
      `All ${picks.length} together: ${(sim.joint * 100).toFixed(sim.joint < 0.01 ? 2 : 1)}% (so treat these as single bets, not one parlay).`,
      `Games with no proven pick are left out. ${PROVEN_NOTE}`, ...noteTier(picks), ...priceNote(d)],
    followups: ["Top 5 TD scorers", "Best value bets this week", "Safest 3-leg parlay"],
  };
}

export function answerProps(d: AskData, market: string, n: number, f: Filters, side?: "over" | "under", line?: number): Answer {
  const label = d.props[market]?.label ?? market;
  if (!d.props[market]) return { title: label, summary: `${label} has not passed validation, so the site does not give chances for it.`, notes: [], followups: ["Best value bets this week"] };
  const picks = propPool(d, market, f, line != null ? side ?? "over" : side, line);
  const seen = new Set<string>();
  const uniq = picks.filter((p) => (seen.has(p.player_id) ? false : (seen.add(p.player_id), true))).slice(0, n);
  if (!uniq.length) {
    const proj = (d.props[market].rows ?? []).filter((r) => r.eligible && propPlays(d, r, market) && keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id }))
      .sort((a, b) => b.median - a.median).slice(0, n);
    return {
      title: `${label}: projections${describe(f) ? ` (${describe(f)})` : ""}`,
      summary: d.feed.at ? `Our odds plan does not pull book lines for ${lc(label)}, so here are the projections (the middle outcome and the range he lands in 8 times out of 10). Ask about a specific line, like "Gibbs over 17.5 carries", for a chance.`
        : "No sportsbook lines are loaded for this market yet, so here are the projections (the middle outcome and the range he lands in 8 times out of 10). Over/under chances appear once lines arrive (the Saturday price pull), or ask about a specific line.",
      projections: proj.map((r) => ({ name: r.player_name, team: r.team, pos: r.position, market, median: r.median, range: [r.q10, r.q90] })),
      notes: [], followups: ["Best value bets this week", "Top 5 TD scorers"],
    };
  }
  return {
    title: line != null ? `Most likely to go ${side === "under" ? "under" : "over"} ${line} ${lc(label)}${describe(f) ? ` (${describe(f)})` : ""}`
      : `Best ${side ?? "over/under"} ${lc(label)} picks${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: line != null ? `Chance each player clears ${line}, from the validated ${lc(label)} model. Prices are shown only where a book offers that exact line.`
      : `Most likely side at the line most books offer, from the validated ${lc(label)} model.`,
    picks: uniq, notes: [...noteTier(uniq), ...priceNote(d)], followups: [`${label} best value`, "Safest 3-leg parlay", "One TD scorer from each game"],
  };
}

export function answerValue(d: AskData, n: number, f: Filters, markets?: string[]): Answer {
  if (!d.feed.at) return { title: "Best value bets", summary: "Value needs sportsbook prices, and none are loaded for this week yet. They arrive with the Saturday price pull.", notes: [], followups: ["Top 5 TD scorers", "One TD scorer from each game"] };
  const ms = markets ?? ["td", ...Object.keys(d.props)];
  const all = ms.flatMap((m) => (m === "td" ? tdPool(d, f) : propPool(d, m, f))).filter((p) => p.edge != null && p.edge >= MIN_EDGE);
  all.sort((a, b) => (b.edge as number) - (a.edge as number));
  const seen = new Set<string>();
  const picks = all.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).slice(0, n);
  if (!picks.length) return { title: "Best value bets", summary: `No leg${describe(f) ? ` (${describe(f)})` : ""} beats the best sportsbook price by 3 points or more right now. Passing is part of winning: book prices are sharp.`, notes: [], followups: ["Top 5 TD scorers"] };
  return {
    title: `Best value${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: "Where our chance beats the chance implied by the best price at any US book by the widest margin (3 points minimum).",
    picks, notes: ["The implied chance includes the book's margin. An edge is an estimate, not a sure thing; the against-the-books record on the Track record page builds week by week.", ...noteTier(picks)],
    followups: ["Build a value parlay", "Top 5 TD scorers", "One TD scorer from each game"],
  };
}

export function answerParlay(d: AskData, legs: number, f: Filters, opts: { market?: string; value?: boolean; sameGame?: boolean; side?: "over" | "under" } = {}): Answer {
  // No market named: the highest-chance legs from every market (anytime TD and the likelier side of each prop).
  const market = opts.market ?? "any";
  let pool = market === "td" ? tdPool(d, f).slice(0, 40) : market === "any" ? anyPool(d, f).slice(0, 60) : propPool(d, market, f, opts.side).filter((p) => p.p >= 0.5);
  if (opts.side && market === "any") pool = Object.keys(d.props).flatMap((m) => propPool(d, m, f, opts.side)).filter((p) => p.p >= 0.5).sort((a, b) => b.p - a.p).slice(0, 80);
  if (!opts.value) pool = pool.filter((p) => isProven(d, p));
  if (new Set(pool.map((p) => p.game_id)).size === 1) opts = { ...opts, sameGame: true }; // a single-game slate (e.g. Thursday)
  if (opts.value) pool = pool.filter((p) => p.price != null && (p.edge as number) >= MIN_EDGE);
  const chosen: Pick[] = [];
  let current = opts.value ? 0 : -1;
  for (let k = 0; k < legs; k++) {
    let best: Pick | null = null, bestScore = -Infinity;
    for (const c of pool) {
      if (chosen.some((x) => x.player_id === c.player_id)) continue;
      if (!opts.sameGame && chosen.some((x) => x.game_id === c.game_id)) continue;
      const set = [...chosen, c];
      const p = simulate(set.map(toSim), d.buckets, d.useCorr, 6000, 99).joint;
      const score = opts.value ? p * set.reduce((a, x) => a * dec(x.price as number), 1) - 1 : p;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best || (opts.value && bestScore <= current)) break;
    chosen.push(best);
    current = bestScore;
  }
  if (!chosen.length) return none(d, opts.value ? "No legs beat the best price by 3+ points" : "Not enough proven legs to build that parlay", f);
  const sim = simulate(chosen.map(toSim), d.buckets, d.useCorr, 40000);
  const priced = chosen.every((p) => p.price != null);
  const price = priced ? chosen.reduce((a, p) => a * dec(p.price as number), 1) : undefined;
  return {
    title: `${opts.value ? "Best value" : "Safest"} ${chosen.length}-leg ${market === "td" ? "TD " : ""}parlay${market === "any" ? " (any market)" : ""}${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: opts.value ? "Built only from legs that beat the best book price, combined for the highest expected return." :
      `The combination most likely to hit, from 40,000 simulated weeks${opts.sameGame ? "" : " (one leg per game)"}.`,
    picks: chosen, parlay: { joint: sim.joint, independent: sim.independent, price, legs: chosen.length },
    notes: [...(chosen.length < legs && !opts.value ? [`Only ${chosen.length} leg${chosen.length === 1 ? "" : "s"} from confidence tiers that hit 50%+ on unseen weeks fit this ask${opts.sameGame ? "" : " (one per game)"}, so the parlay stops there rather than adding weaker legs.`] : []),
      price ? `Best prices multiplied: ${american(price)}, which implies ${pct(1 / price)} vs our ${pct(sim.joint)}.` : "Add prices in the parlay builder to compare against the books.",
      ...(chosen.some((p) => p.lineSource === "usual") ? ["Some legs use the player's usual line because no book line is loaded for them; check the book's line before betting."] : []),
      ...(opts.value ? [] : [PROVEN_NOTE]), ...noteTier(chosen)],
    followups: ["Open this in the parlay builder", "Best value bets this week", "One TD scorer from each game"],
  };
}

export function answerPlayer(d: AskData, ids: string[], only?: string): Answer {
  const groups: { title: string; picks: Pick[] }[] = [];
  const projections: NonNullable<Answer["projections"]> = [];
  const reasons: string[] = [];
  for (const id of ids) {
    const r = d.td.find((x) => x.player_id === id);
    const picks: Pick[] = [];
    if (r?.p_model != null && (!only || only === "td")) picks.push(tdPick(d, r));
    let name = r?.player_name, team = r?.team, pos = r?.position;
    for (const [m, { rows }] of Object.entries(d.props)) {
      if (only && only !== m) continue;
      const pr = rows.find((x) => x.player_id === id && x.eligible && x.dist);
      if (!pr) continue;
      name ??= pr.player_name; team ??= pr.team; pos ??= pr.position;
      const line = feedLine(d.feed, m, id);
      if (line != null) {
        const o = propPick(d, m, pr, line, "over"), u = propPick(d, m, pr, line, "under");
        picks.push(o.p >= u.p ? o : u);
      } else projections.push({ name: pr.player_name, team: pr.team, pos: pr.position, market: m, median: pr.median, range: [pr.q10, pr.q90] });
    }
    if (!name) {
      // Not active this week (injured reserve, out, no role): name him and say why instead of "Player".
      const any = Object.values(d.props).flatMap((x) => x.rows).find((x) => x.player_id === id) as (PropRow & { exclusion?: string | null }) | undefined;
      if (any) { name = any.player_name; team = any.team; pos = any.position; if (any.exclusion) reasons.push(`${any.player_name} is not active this week: ${any.exclusion.replace(/^Roster status RES$/, "on injured reserve").replace(/^Roster status /, "roster status ")}.`); }
    }
    if (r?.reasons?.length && (!only || only === "td")) reasons.push(`${r.player_name}: ${r.reasons.slice(0, 3).map((x) => x.text).join("; ")}.`);
    groups.push({ title: `${name ?? "Player"}${team ? ` (${pos}, ${team}${r?.opponent ? ` vs ${r.opponent}` : ""})` : ""}`, picks });
  }
  const any = groups.some((g) => g.picks.length) || projections.length;
  return {
    title: groups.map((g) => g.title.split(" (")[0]).join(" vs "),
    summary: any ? (ids.length > 1 ? "Side by side: every validated chance we have for each player this week." : "Every validated chance we have for this player this week. For props, the more likely side at the book line is shown.")
      : reasons.find((x) => x.includes("not active")) ?? "No validated chances for this player this week (not eligible, injured, or not enough recent volume).",
    groups, projections: projections.length ? projections : undefined, notes: [...reasons, ...noteTier(groups.flatMap((g) => g.picks)), ...priceNote(d)],
    followups: ["Top 5 TD scorers", "One TD scorer from each game"],
  };
}

/* ------------------------------------------------------------------ why */
/** Everything behind one prop lean, in plain words: support, what argues against it, and the raw numbers. */
function explainProp(d: AskData, r: PropRow, m: string, forceSide?: "over" | "under"): Pick {
  const label = d.props[m]?.label ?? m;
  const book = feedLine(d.feed, m, r.player_id);
  const line = book ?? usualLine(r, m) ?? Math.floor(r.median) + 0.5;
  const over = pOver(r.dist as PropDist, line);
  const side = forceSide ?? (over >= 0.5 ? "over" : "under");
  const pick = { ...propPick(d, m, r, line, side), lineSource: book != null ? "book" as const : "usual" as const };
  const pro = (side === "under" ? underReasons : overReasons)(r, m, label, line);
  const con = (side === "under" ? overReasons : underReasons)(r, m, label, line);
  const e = r.evidence ?? {};
  const st = statOf(m);
  const facts: string[] = [];
  facts.push(`Projection ${num1(r.median)} (8 in 10 games between ${num1(r.q10)} and ${num1(r.q90)}) against a line of ${line}${book == null ? " (his usual line; no book line loaded)" : ""}.`);
  const rec = (r.recent ?? []).slice(0, 8);
  if (rec.length) facts.push(`Last ${rec.length} games, newest first: ${rec.map((g) => `${num1(g.value)} vs ${g.opponent}`).join(", ")}. Over ${line} in ${rec.filter((g) => g.value > line).length} of ${rec.length}.`);
  const avg = [e[`${st}_cur`] != null ? `season ${num1(e[`${st}_cur`] as number)}` : "", e[`${st}_l3`] != null ? `last 3 ${num1(e[`${st}_l3`] as number)}` : "",
    e[`${st}_med`] != null ? `typical game ${num1(e[`${st}_med`] as number)}` : ""].filter(Boolean);
  if (avg.length) facts.push(`His ${lc(label)}: ${avg.join(", ")}.`);
  const mult = e[`opp_${st}_mult`];
  if (mult != null) facts.push(`${r.opponent} allows ${Math.abs(Math.round((mult - 1) * 100))}% ${mult >= 1 ? "more" : "fewer"} ${lc(label)} to ${POS_NAME[r.position] ?? r.position} than average (games before this week).`);
  const role = [e.targets_pg != null ? `${num1(e.targets_pg)} targets/game` : "", e.targets_share != null ? `${Math.round(e.targets_share * 100)}% target share` : "",
    e.carries_pg != null && r.position !== "WR" && r.position !== "TE" ? `${num1(e.carries_pg)} carries/game` : "", e.attempts_pg != null ? `${num1(e.attempts_pg)} pass attempts/game` : "",
    e.snap_pct != null ? `${Math.round(e.snap_pct * 100)}% of snaps` : ""].filter(Boolean);
  if (role.length) facts.push(`Role: ${role.join(", ")}.`);
  const hist = d.conf?.props?.line_history?.[m]?.find((h) => line >= h.lo && line <= h.hi);
  if (hist) {
    const typical = e[`${st}_med`];
    facts.push(`In testing, players whose usual line was ${hist.lo === hist.hi ? hist.lo : `${hist.lo}–${hist.hi}`} averaged ${num1(hist.avg_actual)} the next game and went over ${pct(hist.over_rate)} of the time (${hist.n.toLocaleString()} games).`
      + (hist.avg_actual < hist.avg_line && typical != null && r.median < typical ? " Big recent numbers tend to come back down, which is why his projection sits below his recent averages." : ""));
  }
  if (e.team_implied_total != null) facts.push(`Game script: his team is projected for ${num1(e.team_implied_total)} points${e.opp_implied_total != null ? `, the opponent ${num1(e.opp_implied_total)}` : ""}.`);
  return { ...pick, reasons: pro, against: con, facts };
}

/** "Will Puka go over 6.5 receptions?": the named player's chance at that exact line, with his recent record against it. */
export function answerPlayerLine(d: AskData, ids: string[], market: string, side: "over" | "under", line: number): Answer {
  const label = d.props[market]?.label ?? market;
  const picks: Pick[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const r = d.props[market]?.rows.find((x) => x.player_id === id && x.dist);
    if (!r) { missing.push(d.td.find((x) => x.player_id === id)?.player_name ?? Object.values(d.props).flatMap((x) => x.rows).find((x) => x.player_id === id)?.player_name ?? "That player"); continue; }
    const pk = propPick(d, market, r, line, side);
    const rec = (r.recent ?? []).slice(0, 8);
    const hits = rec.filter((g) => (side === "over" ? g.value > line : g.value < line)).length;
    const book = feedLine(d.feed, market, id);
    picks.push({ ...pk, lineSource: book === line ? "book" : undefined, reasons: [
      `Projection ${num1(r.median)}; 8 in 10 games should land between ${num1(r.q10)} and ${num1(r.q90)}`,
      rec.length ? `${side === "over" ? "Over" : "Under"} ${line} in ${hits} of his last ${rec.length} games: ${rec.map((g) => num1(g.value)).join(", ")}` : "No recent games to compare",
      book != null ? (book === line ? `This is the book line${pk.price != null ? ` (${fmtPrice(pk.price)} at ${pk.book})` : ""}` : `The book line is ${book}, so ${line} may not be offered`) : "No book line loaded for him in this market"] });
  }
  if (!picks.length) return { title: `No ${lc(label)} numbers for ${missing.join(" or ")}`, summary: `${missing.join(" and ")} ${missing.length > 1 ? "have" : "has"} no validated ${lc(label)} projection this week (not playing, too small a role, or this prop is not validated).`, notes: [], followups: [`Best ${lc(label)} picks`, "Top 5 TD scorers"] };
  const one = picks[0];
  return {
    title: picks.length === 1 ? `${one.name} ${side} ${line} ${lc(label)}: ${pct(one.p)}` : `${side === "over" ? "Over" : "Under"} ${line} ${lc(label)}`,
    summary: picks.length === 1 ? `Our model gives ${one.name} a ${pct(one.p)} chance to go ${side} ${line} ${lc(label)}${one.tier ? ` (${one.tier}: picks in that range hit ${pct(one.tierRate ?? 0)} on unseen weeks)` : ""}.`
      + (one.p < 0.5 ? ` That makes the ${side === "over" ? "under" : "over"} the better side at ${pct(1 - one.p)}${(() => { const t = tierFor(d.conf, "props", 1 - one.p); return t ? ` (${t.tier})` : ""; })()}.` : "")
      : "Each player's chance at that line, from the validated model.",
    picks, notes: [...(missing.length ? [`No ${lc(label)} numbers for ${missing.join(", ")}.`] : []), ...noteTier(picks)],
    followups: [`${one.name} ${lc(label)} at every line`, `Why ${one.name}?`, "Safest 3-leg parlay"],
  };
}

/** "Is Swift a good bet at -160?": our chance against the chance that price implies. */
export function answerPriceCheck(d: AskData, ids: string[], price: number, market: string | undefined, side?: "over" | "under", line?: number): Answer {
  const implied = 1 / dec(price);
  const picks: Pick[] = [];
  for (const id of ids) {
    let pk: Pick | null = null;
    if (!market || market === "td") {
      const r = d.td.find((x) => x.player_id === id && x.p_model != null);
      if (r) pk = tdPick(d, r);
    } else {
      const r = d.props[market]?.rows.find((x) => x.player_id === id && x.dist);
      if (r) {
        const ln = line ?? feedLine(d.feed, market, id) ?? estimatedLine(r, market).line;
        const over = pOver(r.dist as PropDist, ln);
        pk = propPick(d, market, r, ln, side ?? (over >= 0.5 ? "over" : "under"));
      }
    }
    if (!pk) continue;
    const edge = pk.p - implied;
    const verdict = edge >= MIN_EDGE ? `Value: our ${pct(pk.p)} beats the ${pct(implied)} that ${fmtPrice(price)} implies (+${Math.round(edge * 100)} points)`
      : edge > -MIN_EDGE ? `Fair price: ${fmtPrice(price)} implies ${pct(implied)} and we have ${pct(pk.p)}, so there is no real edge either way`
        : `Overpriced: ${fmtPrice(price)} implies ${pct(implied)} but we have ${pct(pk.p)} (${Math.round(edge * 100)} points)`;
    const fair = pk.p >= 0.5 ? Math.round(-100 * pk.p / (1 - pk.p)) : Math.round(100 * (1 - pk.p) / pk.p);
    picks.push({ ...pk, reasons: [verdict, `Our fair price: ${fmtPrice(fair)}. Anything longer than that is a better bet than this one`,
      ...(pk.price != null && pk.price !== price ? [`Best price we have loaded: ${fmtPrice(pk.price)} (${pk.book})`] : [])] });
  }
  if (!picks.length) return { title: "No chance to compare", summary: "That player has no validated chance for this bet this week.", notes: [], followups: ["Top 5 TD scorers"] };
  const one = picks[0];
  const e = one.p - implied;
  return {
    title: picks.length === 1 ? `${one.name} ${one.label} at ${fmtPrice(price)}: ${e >= MIN_EDGE ? "value" : e > -MIN_EDGE ? "fair price" : "overpriced"}` : `Price check at ${fmtPrice(price)}`,
    summary: `${fmtPrice(price)} implies a ${pct(implied)} chance. ${picks.map((x) => `${x.name}: ${pct(x.p)}`).join(", ")}. A bet is worth it when our chance is at least ${Math.round(MIN_EDGE * 100)} points above the implied chance.`,
    picks, notes: noteTier(picks), followups: ["Best value bets this week", `Why ${one.name}?`, "Bets to avoid"],
  };
}

export function answerWhy(d: AskData, ids: string[], market?: string, side?: "over" | "under"): Answer {
  const id = ids[0];
  const td = d.td.find((x) => x.player_id === id);
  const rows = Object.entries(d.props).map(([m, v]) => ({ m, r: v.rows.find((x) => x.player_id === id && x.dist) })).filter((x) => x.r) as { m: string; r: PropRow }[];
  const name = td?.player_name ?? rows[0]?.r.player_name ?? "This player";
  const picks: Pick[] = [];
  if (market && market !== "td") {
    const x = rows.find((y) => y.m === market);
    if (x) picks.push(explainProp(d, x.r, market, side));
  } else if (market === "td" || (!side && td?.p_model != null && !rows.length)) {
    if (td?.p_model != null) picks.push({ ...tdPick(d, td), reasons: td.reasons.filter((x) => x.sign >= 0).map((x) => x.text), against: td.reasons.filter((x) => x.sign < 0).map((x) => x.text) });
  } else {
    // No market named: explain his strongest lean (the side asked about, if any), plus his TD chance for context.
    const all = rows.map((x) => explainProp(d, x.r, x.m, side)).sort((a, b) => b.p - a.p);
    if (all[0]) picks.push(all[0]);
    if (td?.p_model != null && !side) picks.push({ ...tdPick(d, td), reasons: td.reasons.filter((x) => x.sign >= 0).map((x) => x.text), against: td.reasons.filter((x) => x.sign < 0).map((x) => x.text) });
  }
  if (!picks.length) return { title: `Why: ${name}`, summary: `No validated chance for ${name}${market ? ` in ${d.props[market]?.label ?? market}` : ""} this week, so there is nothing to explain.`, notes: [], followups: ["Top 5 TD scorers"] };
  const top = picks[0];
  return {
    title: `Why ${top.label.toLowerCase().startsWith("anytime") ? `${name} to score` : `${name}: ${top.label}`}`,
    summary: `The model gives this a ${pct(top.p)} chance${top.tierData?.rate != null ? ` (${top.tier}: picks in that range have hit ${pct(top.tierData.rate)} of the time on unseen weeks)` : ""}. It weighs everything below together; no single factor decides it.`,
    picks, sections: tidy([{ title: "The numbers behind it", lines: top.facts ?? [] }, { title: "Price, track record and matchup", lines: whyContext(d, top) }]), notes: priceNote(d),
    followups: [`${name} all props`, `Why is ${top.team} favored?`, "Who will fall short this week?"],
  };
}

/** Price, tier record and the opponent's defense behind one "why" answer. */
function whyContext(d: AskData, p: Pick): string[] {
  const out: string[] = [];
  if (p.price != null && p.book) {
    const implied = 1 / dec(p.price);
    out.push(`Best price ${fmtPrice(p.price)} at ${p.book} implies ${pct(implied)}; our ${pct(p.p)} is ${p.p - implied >= MIN_EDGE ? `a ${Math.round((p.p - implied) * 100)}-point edge` : p.p - implied > -MIN_EDGE ? "about the same, so no real edge" : `${Math.round((implied - p.p) * 100)} points below it, so the price is too high`}.`);
  }
  if (p.tierData?.rate != null) out.push(`${p.tier} tier: ${p.tierData.hits.toLocaleString()} of ${p.tierData.n.toLocaleString()} past picks in that range hit (${pct(p.tierData.rate)}) on weeks the model never saw${p.tierData.avg_chance != null ? `, against an average predicted chance of ${pct(p.tierData.avg_chance)}` : ""}.`);
  const def = d.defenses?.teams.find((x) => x.defense === p.opp);
  if (def?.available) out.push(...defenseLines(d, def, p.team).slice(0, 2));
  return out;
}

export function answerGame(d: AskData, teams: string[], f: Filters): Answer {
  const games = new Map<string, string[]>();
  for (const r of d.td) if (r.game_id && teams.includes(r.team)) games.set(r.game_id, [...new Set([...(games.get(r.game_id) ?? []), r.team])]);
  // Two named teams that meet each other: just that game.
  const shared = [...games].filter(([, t]) => t.length > 1).map(([g]) => g);
  const ids = shared.length ? shared : [...games.keys()];
  if (!ids.length) return none(d, `No chances for ${teams.join("/")} this week`, f);
  const groups: { title: string; picks: Pick[] }[] = [];
  for (const gid of ids) {
    const g = gameTeams(gid);
    const inGame = { ...f, teams: [g.away, g.home], teamOnly: true };
    groups.push({ title: `${gameLabel(gid)}: anytime TD`, picks: tdPool(d, inGame).slice(0, 8) });
    const props = Object.keys(d.props).flatMap((m) => propPool(d, m, inGame).slice(0, 2)).sort((a, b) => b.p - a.p).slice(0, 5);
    if (props.length) groups.push({ title: `${gameLabel(gid)}: props`, picks: props });
  }
  return {
    title: ids.map(gameLabel).join(" · "), summary: `Most likely touchdown scorers${groups.some((x) => x.title.endsWith("props")) ? " and strongest prop sides" : ""}, both teams.`,
    groups, notes: [...noteTier(groups.flatMap((x) => x.picks)), ...priceNote(d)], followups: [`Why is ${teams[0]} favored?`, `Safest 2-leg same game parlay ${teams[0]}`, "One TD scorer from each game"],
  };
}

export function answerAvoid(d: AskData, n: number, f: Filters): Answer {
  if (!d.feed.at) return { title: "Bets to avoid", summary: "This needs sportsbook prices, and none are loaded for this week yet.", notes: [], followups: ["Top 5 TD scorers"] };
  const picks = ["td", ...Object.keys(d.props)].flatMap((m) => (m === "td" ? tdPool(d, { ...f, safe: false }) : propPool(d, m, f)))
    .filter((p) => p.edge != null && p.edge <= -0.05).sort((a, b) => (a.edge as number) - (b.edge as number)).slice(0, n);
  if (!picks.length) return { title: "Bets to avoid", summary: "No popular bet is priced far above our chance right now.", notes: [], followups: ["Best value bets"] };
  return {
    title: `Overpriced bets to avoid${describe(f) ? ` (${describe(f)})` : ""}`, summary: "Even the best price implies a much higher chance than our model gives: the book is charging too much here.",
    picks, notes: noteTier(picks), followups: ["Best value bets", "Top 5 TD scorers"],
  };
}

/* ------------------------------------------------------------------ unders: where a player falls short */
const STAT: Record<string, string> = { pass_attempts: "attempts" };
const statOf = (m: string) => STAT[m] ?? m;
const POS_NAME: Record<string, string> = { QB: "quarterbacks", RB: "running backs", WR: "receivers", TE: "tight ends" };
const YARDS = new Set(["pass_yards", "rush_yards", "rec_yards", "rush_rec_yards", "pass_tds"]);

/** The line to show before books post one: his recent median rounded to a book-style half point (the line the
 *  backtest graded), unless that sits far from this week's projection. Then his recent games came in a different role
 *  (a backup now starting, a starter coming back from a short game) and no book would post it (e.g. 4.5 pass attempts
 *  for a starting QB), so this week's projection, rounded the same way, is used instead and marked as projected. */
export function estimatedLine(r: { median: number; evidence?: Record<string, number | null> }, market: string): { line: number; kind: "usual" | "projected" } {
  const m = r.evidence?.[`${statOf(market)}_med`];
  const projected = { line: Math.max(0.5, Math.floor(r.median) + 0.5), kind: "projected" as const };
  if (m == null) return projected;
  const line = Math.floor(m) + 0.5;
  return Math.abs(r.median - line) > Math.max(1.5, 0.2 * Math.max(line, r.median)) ? projected : { line, kind: "usual" };
}
export function usualLine(r: PropRow, market: string): number | null {
  return estimatedLine(r, market).line;
}

/** Plain reasons a player may fall short of a line, strongest first, from pregame data only. */
export function underReasons(r: PropRow, market: string, label: string, line: number): string[] {
  const e = r.evidence ?? {};
  const st = statOf(market);
  const out: { w: number; t: string }[] = [];
  const lab = lc(label);
  const mult = e[`opp_${st}_mult`];
  if (mult != null && mult <= 0.95) out.push({ w: 1 - mult, t: `${r.opponent} allows ${Math.round((1 - mult) * 100)}% fewer ${lab} to ${POS_NAME[r.position] ?? r.position} than average` });
  const rec = (r.recent ?? []).slice(0, 8);
  if (rec.length >= 4) {
    const k = rec.filter((g) => g.value < line).length;
    if (k / rec.length >= 0.6) out.push({ w: (k / rec.length - 0.5), t: `Under ${line} in ${k} of his last ${rec.length} games` });
  }
  const l3 = e[`${st}_l3`];
  if (l3 != null && l3 < line) out.push({ w: Math.min(0.4, (line - l3) / Math.max(line, 1)), t: `Averaging ${num1(l3)} over his last 3 games` });
  const med = e[`${st}_med`];
  if (med != null && med < line - 0.5) out.push({ w: Math.min(0.3, (line - med) / Math.max(line, 1)), t: `His typical game is ${num1(med)}` });
  const tt = e.team_implied_total;
  if (tt != null && tt <= 20 && YARDS.has(market)) out.push({ w: (21 - tt) / 40, t: `Team projected for only ${num1(tt)} points` });
  const share = e.targets_share ?? e.carries_share;
  if (share != null && share < 0.15 && ["rec_yards", "receptions", "rush_yards", "carries", "rush_rec_yards"].includes(market)) out.push({ w: 0.1, t: `Only ${Math.round(share * 100)}% of his team's ${e.targets_share != null ? "targets" : "carries"}` });
  const snap = e.snap_pct;
  if (snap != null && snap < 0.6 && r.position !== "QB") out.push({ w: 0.08, t: `Plays ${Math.round(snap * 100)}% of snaps` });
  return out.sort((a, b) => b.w - a.w).slice(0, 3).map((x) => x.t);
}
/** Plain reasons a player may clear a line, strongest first, from pregame data only. */
export function overReasons(r: PropRow, market: string, label: string, line: number): string[] {
  const e = r.evidence ?? {};
  const st = statOf(market);
  const out: { w: number; t: string }[] = [];
  const mult = e[`opp_${st}_mult`];
  if (mult != null && mult >= 1.05) out.push({ w: mult - 1, t: `${r.opponent} allows ${Math.round((mult - 1) * 100)}% more ${lc(label)} to ${POS_NAME[r.position] ?? r.position} than average` });
  const rec = (r.recent ?? []).slice(0, 8);
  if (rec.length >= 4) {
    const k = rec.filter((g) => g.value > line).length;
    if (k / rec.length >= 0.6) out.push({ w: (k / rec.length - 0.5), t: `Over ${line} in ${k} of his last ${rec.length} games` });
  }
  const l3 = e[`${st}_l3`];
  if (l3 != null && l3 > line) out.push({ w: Math.min(0.4, (l3 - line) / Math.max(line, 1)), t: `Averaging ${num1(l3)} over his last 3 games` });
  const med = e[`${st}_med`];
  if (med != null && med > line + 0.5) out.push({ w: Math.min(0.3, (med - line) / Math.max(line, 1)), t: `His typical game is ${num1(med)}` });
  const tt = e.team_implied_total;
  if (tt != null && tt >= 25 && YARDS.has(market)) out.push({ w: (tt - 24) / 40, t: `Team projected for ${num1(tt)} points` });
  const share = e.targets_share ?? e.carries_share;
  if (share != null && share >= 0.25 && ["rec_yards", "receptions", "rush_yards", "carries", "rush_rec_yards"].includes(market)) out.push({ w: 0.1, t: `Gets ${Math.round(share * 100)}% of his team's ${e.targets_share != null ? "targets" : "carries"}` });
  return out.sort((a, b) => b.w - a.w).slice(0, 3).map((x) => x.t);
}
const num1 = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));

/** Under legs across markets: at the book line when books offer one, otherwise at the player's usual line. */
export function underPool(d: AskData, f: Filters = {}, markets?: string[], minChance = 0.55): Pick[] {
  const out: Pick[] = [];
  for (const m of markets ?? Object.keys(d.props)) {
    const label = d.props[m]?.label ?? m;
    for (const r of d.props[m]?.rows ?? []) {
      if (!r.eligible || !r.dist || !propPlays(d, r, m)) continue;
      if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
      const book = feedLine(d.feed, m, r.player_id);
      const line = book ?? usualLine(r, m);
      if (line == null || line <= 0) continue;
      const p = propPick(d, m, r, line, "under");
      if (p.p < minChance) continue;
      out.push({ ...p, lineSource: book != null ? "book" : "usual", reasons: underReasons(r, m, label, line) });
    }
  }
  return out.sort((a, b) => b.p - a.p);
}

export function answerUnders(d: AskData, n: number, f: Filters, markets?: string[]): Answer {
  const pool = underPool(d, f, markets).filter((p) => p.reasons?.length);
  const seen = new Set<string>();
  const picks = pool.filter((p) => (seen.has(p.player_id) ? false : (seen.add(p.player_id), true))).slice(0, n);
  const what = markets?.length === 1 ? (d.props[markets[0]] ? lc(d.props[markets[0]].label) : "") + " " : "";
  if (!picks.length) return none(d, `No strong ${what}unders${describe(f) ? ` for ${describe(f)}` : ""}`, f);
  const usual = picks.some((p) => p.lineSource === "usual");
  const u = d.conf?.props?.by_side?.under;
  return {
    title: `Where players should fall short: ${what}unders${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: "Most likely unders, with the matchup and form behind each one: the opponent's defense against that position, recent games, role and team scoring outlook.",
    picks, notes: [
      ...(usual ? ["Where no book line is loaded yet, the line shown is the player's usual line (his recent median, rounded to a half point), the same line the track record grades."] : []),
      ...(u ? [`Track record for unders: ${u.map((t) => `${t.tier} ${t.rate != null ? pct(t.rate) : "–"} of ${t.n.toLocaleString()}`).join(", ")}.`] : []),
      ...priceNote(d)],
    followups: ["Receiving yards unders", "Passing yards unders", "Best value bets"],
  };
}

export function answerSleepers(d: AskData, n: number, f: Filters): Answer {
  const pool = tdPool(d, f).filter((p) => p.p >= 0.2 && p.p < 0.35);
  const picks = (d.feed.at ? pool.filter((p) => p.edge != null).sort((a, b) => (b.edge as number) - (a.edge as number)) : pool).slice(0, n);
  if (!picks.length) return none(d, "No longer-shot TD picks match that", f);
  return {
    title: `Longer-shot TD picks${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: d.feed.at ? "Players with a 20–35% chance to score, ranked by how far our chance beats the best price." : "Players with a 20–35% chance to score: bigger payouts, lower hit rates.",
    picks, notes: [...noteTier(picks), ...priceNote(d)], followups: ["Top 5 TD scorers", "Best value bets"],
  };
}

export function answerDue(d: AskData, n: number, f: Filters): Answer {
  const picks = tdPool(d, f).filter((p) => p.due).sort((a, b) => (b.due as Due).gap - (a.due as Due).gap).slice(0, n)
    .map((p) => { const x = p.due as Due; return { ...p, reasons: [`${x.actual} TD${x.actual === 1 ? "" : "s"} on ${num1(x.expected)} expected from his carries and targets in ${x.games} games`] }; });
  if (!picks.length) return none(d, "No player is due right now", f);
  const r = d.dueRecord;
  return {
    title: `Due for a touchdown${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: "Players who have scored at least 1.5 fewer TDs this season than their opportunities predicted, biggest gap first. The chance shown already counts that opportunity.",
    picks, notes: [
      r?.hit_rate != null && r.season_td_rate != null && r.avg_chance != null
        ? `In ${r.n.toLocaleString()} past cases, due players scored in ${pct(r.hit_rate)} of games, well above their ${pct(r.season_td_rate)} rate so far and close to the ${pct(r.avg_chance)} the model gave, so the bounce-back is real and already in the chances.`
        : "The chance shown already includes his opportunity, so being due is not added on top.",
      ...priceNote(d)],
    followups: ["Top 5 TD scorers", "Best value bets"],
  };
}

export function answerInjuries(d: AskData, f: Filters): Answer {
  const rows = d.td.filter((r) => status(r) && keep(d, { ...f, safe: false }, { pos: r.position, team: r.team, opp: r.opponent ?? "", game_id: r.game_id ?? "" }))
    .sort((a, b) => (b.p_model ?? 0) - (a.p_model ?? 0)).slice(0, 15);
  if (!rows.length) return { title: "Injury report", summary: "No skill players on this week's injury report match that (or the report is not out yet).", notes: [], followups: ["Top 5 TD scorers"] };
  return {
    title: "Injury report: notable players", summary: "Players listed on the official report, highest TD chance first. Built-in picks leave out anyone Questionable or worse.",
    picks: rows.filter((r) => r.p_model != null).map((r) => tdPick(d, r)), notes: [], followups: ["Top 5 TD scorers"],
  };
}

export function answerRecord(d: AskData): Answer {
  const t = d.conf?.td, p = d.conf?.props;
  const line = (x: { tier: string; rate: number | null; n: number; avg_chance: number | null }) => `${x.tier}: ${x.rate != null ? pct(x.rate) : "–"} hit in ${x.n.toLocaleString()} past picks (average chance ${x.avg_chance != null ? pct(x.avg_chance) : "–"})`;
  return {
    title: "How accurate is the model?",
    summary: t ? `Every chance was tested on games the model had not seen (${t.weeks} weeks since ${t.first_season}). Picks in each tier hit about as often as their chances said.` : "The confidence record is not available.",
    notes: [...(t?.tiers.map((x) => `Anytime TD ${line(x)}`) ?? []), ...(p?.tiers.map((x) => `Props ${line(x)}`) ?? [])],
    followups: ["Top 5 TD scorers", "Best value bets"],
  };
}

function none(d: AskData, title: string, f: Filters): Answer {
  return { title, summary: `Nothing matched${describe(f) ? ` for ${describe(f)}` : ""}. Try widening the filter.`, notes: priceNote(d), followups: EXAMPLES.slice(0, 3) };
}

export function toSim(p: Pick): SimLeg {
  return { id: p.id, market: p.market, player_id: p.player_id, team: p.team, position: p.pos, game_id: p.game_id, p: p.p, side: p.side };
}

/* ------------------------------------------------------------------ hit rates, ladders, defenses, games, terms */
const frac = (h: number, n: number) => `${h} of ${n}`;
export const PLAYABLE_NOTE = "Only lines a book would realistically offer are used: about 30% either side of the main book line (or this week's projection until lines are loaded), where alternate lines usually stop. Exact alternate lines replace this estimate when they are pulled.";

/** Props a player has cleared in (nearly) every recent game, only at lines a sportsbook actually posts for him: the
 *  highest posted line he cleared at the threshold (lowest for unders), per market. A player or market with no posted
 *  line is left out, so nothing is listed that can't be bet. */
export function answerHitRates(d: AskData, n: number, f: Filters, o: { threshold?: number; window?: number; side?: "over" | "under"; markets?: string[]; fallback?: boolean } = {}): Answer {
  const threshold = o.threshold ?? 1, window = o.window ?? 8, sides = o.side ? [o.side] : (["over"] as const);
  const all: Pick[] = [];
  let anyAlt = false;
  for (const m of o.markets ?? Object.keys(d.props)) {
    for (const r of d.props[m]?.rows ?? []) {
      if (!r.eligible || !r.dist || !propPlays(d, r, m)) continue;
      if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
      for (const side of sides) {
        const lines = bookLines(d.feed, m, r.player_id, side);
        if (!lines.length) continue;
        if (playable(d.feed, m, r).source === "book") anyAlt = true;
        const x = lineAtRate(r, side, threshold, window, 5, { lines, anchor: lines[0], source: "book" });
        if (!x) continue;
        const pk = propPick(d, m, r, x.line, side);
        const h = side === "over" ? x.hits : x.games - x.hits, h5 = side === "over" ? x.hits5 : x.games5 - x.hits5;
        all.push({ ...pk, lineSource: "book", reasons: [
          `${side === "over" ? "Over" : "Under"} ${x.line} in ${frac(h, x.games)} of his last ${x.games} games (last 5: ${frac(h5, x.games5)})`,
          `Recent games: ${(r.recent ?? []).slice(0, window).map((g) => num1(g.value)).join(", ")}`,
          pk.price != null ? `Posted at ${fmtPrice(pk.price)} (${pk.book})` : "Posted by the books this week"] });
      }
    }
  }
  const picks = all.sort((a, b) => b.p - a.p);
  const label = `${Math.round(threshold * 100)}%`;
  if (!d.feed.at) return { title: "Hit rates need the books' lines", summary: "Only props the sportsbooks actually post are listed, and no book lines are loaded for this week yet. They are pulled Saturday morning.", notes: [], followups: ["Who is due for a TD?", "Safest pick, any prop"] };
  if (!picks.length) {
    // Nothing perfect: step down to the best record any posted prop has, so the answer is still useful.
    const lower = o.fallback ? [0.9, 0.8, 0.75].find((t) => t < threshold && answerHitRates(d, 1, f, { ...o, threshold: t, fallback: false }).picks?.length) : undefined;
    if (lower != null) {
      const a = answerHitRates(d, n, f, { ...o, threshold: lower, fallback: false });
      return { ...a, notes: [`No posted prop hit at ${label} over his last ${window} games, so these are the best records (${Math.round(lower * 100)}%+).`, ...a.notes] };
    }
    return none(d, `No posted props at a ${label} hit rate over the last ${window} games`, f);
  }
  return {
    title: `Props at a ${label} hit rate (last ${window} games)${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: `${picks.length} props the books are posting this week where he cleared the line in at least ${label} of his last ${window} games${anyAlt ? ", at the highest posted line that holds" : ""}. Highest model chance first: a perfect recent record does not mean a sure thing, so the model's chance for this week is shown beside each.`,
    picks: picks.slice(0, n), notes: [
      picks.length > n ? `Showing ${n} of ${picks.length}. Narrow it with a market, position or team, or ask for more.` : "",
      anyAlt ? "Lines are the ones the books post, alternate lines included." : "Lines are the main lines the books post (alternate lines need a paid odds plan). Players and markets without a posted line are left out.",
      "Hit rates count games he played. Open a player on the Hit rates page to see every line.", ...priceNote(d)].filter(Boolean),
    followups: ["Props at a 90% hit rate", "Unders at a 100% hit rate last 5", "Best value bets"],
  };
}

/** Floor picks need this model chance (the model's 80%+ calls have hit about that often on unseen games)... */
export const FLOOR_MIN_CHANCE = 0.8;
/** ...and a price no shorter than this: a line at -1200 is not worth betting. */
export const FLOOR_SHORTEST_PRICE = -700;

/** Floor picks: per player and market, the highest over line the books post (main or alternate, shown as "X+") at -700 or
 *  longer that the model gives 80%+ and that he cleared in at least `threshold` of his recent games. Posted lines only. */
export function answerFloorPicks(d: AskData, n: number, f: Filters, o: { threshold?: number; window?: number; markets?: string[] } = {}): Answer {
  const threshold = o.threshold ?? 1, window = o.window ?? 8;
  const all: Pick[] = [];
  for (const m of o.markets ?? Object.keys(d.props)) {
    for (const r of d.props[m]?.rows ?? []) {
      if (!r.eligible || !r.dist || !propPlays(d, r, m)) continue;
      if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
      const rec = (r.recent ?? []).slice(0, window);
      if (rec.length < 5) continue;
      let best: { pk: Pick; hits: number } | null = null;
      for (const line of bookLines(d.feed, m, r.player_id, "over")) {
        const pk = propPick(d, m, r, line, "over");
        const hits = rec.filter((g) => g.value > line).length;
        if (pk.price != null && pk.price < FLOOR_SHORTEST_PRICE) continue;
        if (pk.p >= FLOOR_MIN_CHANCE && hits >= threshold * rec.length - 1e-9 && (!best || line > best.pk.line!)) best = { pk, hits };
      }
      if (!best) continue;
      const { pk, hits } = best, x = Math.ceil(pk.line!);
      const h5 = rec.slice(0, 5).filter((g) => g.value > pk.line!).length;
      all.push({ ...pk, id: `${m}:${r.player_id}:floor`, label: `${x}+ ${lc(d.props[m].label)}`, lineSource: "book", reasons: [
        `Reached ${x}+ in ${frac(hits, rec.length)} of his last ${rec.length} games (last 5: ${frac(h5, Math.min(5, rec.length))})`,
        `Recent games: ${rec.map((g) => num1(g.value)).join(", ")}`,
        `Model chance ${pct(pk.p)}; projection ${num1(r.median)}`,
        pk.price != null ? `Posted at ${fmtPrice(pk.price)} (${pk.book}) as over ${pk.line}` : `Posted as over ${pk.line}`] });
    }
  }
  const picks = all.sort((a, b) => b.p - a.p);
  const label = `${Math.round(threshold * 100)}%`;
  if (!d.feed.at) return { title: "Floor picks need the books' lines", summary: "Only lines the sportsbooks post are listed, and no book lines are loaded for this week yet.", notes: [], followups: ["Props at a 100% hit rate"] };
  if (!picks.length) return none(d, `No floor picks at a ${label} hit rate over the last ${window} games`, f);
  return {
    title: `Floor picks: ${label} hit rate, last ${window} games`,
    summary: `${picks.length} posted lines the model gives ${Math.round(FLOOR_MIN_CHANCE * 100)}%+ that the player also cleared in at least ${label} of his last ${window} games, at the highest posted line that holds. Highest model chance first.`,
    picks: picks.slice(0, n), notes: [picks.length > n ? `Showing ${n} of ${picks.length}.` : "",
      "Only lines the books post, priced -700 or longer. Alternate lines (more rungs) are pulled only on a paid odds plan, so most of these are main lines."].filter(Boolean),
    followups: ["Props at a 100% hit rate", "Safest pick, any prop"],
  };
}

/** Every line for one player and market: model chance and how often he cleared it. */
export function answerLadder(d: AskData, ids: string[], market?: string, window = 8): Answer {
  const id = ids[0];
  const m = market ?? Object.keys(d.props).find((k) => d.props[k].rows.some((r) => r.player_id === id && r.dist));
  const r = m ? d.props[m]?.rows.find((x) => x.player_id === id && x.dist) : undefined;
  if (!m || !r) return { title: "No lines for that player", summary: "No validated prop for that player and market this week.", notes: [], followups: ["Top 5 TD scorers"] };
  const pl = playable(d.feed, m, r);
  const rungs = ladder(r, window, pl);
  const book = feedLine(d.feed, m, id);
  return {
    title: `${r.player_name}: ${d.props[m].label} at every line`,
    summary: `Each line with this week's model chance and how often he cleared it in his last ${rungs[0]?.games ?? 0} games. Projection ${num1(r.median)} (8 in 10 games between ${num1(r.q10)} and ${num1(r.q90)}).${book != null ? ` Book line: ${book}.` : ""}`,
    table: { columns: ["Line", "Model over", "Model under", `Over, last ${rungs[0]?.games ?? 0}`, "Over, last 5"],
      rows: rungs.map((x) => [`${x.line}${x.line === book ? " (book)" : ""}`, pct(x.over ?? 0), pct(1 - (x.over ?? 0)), `${frac(x.hits, x.games)} (${pct(x.games ? x.hits / x.games : 0)})`, frac(x.hits5, x.games5)]) },
    notes: [`Recent games, newest first: ${(r.recent ?? []).slice(0, window).map((g) => `${num1(g.value)} vs ${g.opponent}`).join(", ")}.`,
      pl.source === "book" ? "These are the lines the books post, alternate lines included." : PLAYABLE_NOTE],
    followups: [`Why the ${r.player_name} ${lc(d.props[m].label)} pick?`, "Props at a 100% hit rate"],
  };
}

/** How each defense plays a position this week: TDs allowed vs league average, from games before this week. */
export function answerDefense(d: AskData, position: string | undefined, worst: boolean, n: number): Answer {
  const pos = position ?? "RB";
  const seen = new Map<string, { opp: string; team: string; mult: number; tdpg: number | null; games: number | null; gid: string }>();
  for (const r of d.td) {
    if (r.position !== pos || !r.opponent || seen.has(r.opponent)) continue;
    const mult = r.features?.opp_def_pos_mult;
    if (typeof mult !== "number") continue;
    seen.set(r.opponent, { opp: r.opponent, team: r.team, mult, tdpg: typeof r.features.opp_def_pos_td_pg === "number" ? r.features.opp_def_pos_td_pg : null,
      games: typeof r.features.opp_def_games === "number" ? r.features.opp_def_games : null, gid: r.game_id ?? "" });
  }
  const rows = [...seen.values()].sort((a, b) => (worst ? a.mult - b.mult : b.mult - a.mult)).slice(0, n);
  if (!rows.length) return { title: "No defense data", summary: "Defense splits are not available for this week.", notes: [], followups: [] };
  const name = POS_NAME[pos] ?? pos;
  return {
    title: worst ? `Toughest defenses for ${name} this week` : `Best matchups for ${name} this week`,
    summary: `Touchdowns each defense has allowed to ${name}, compared with the league average (1.00 = average), from games before this week, and who they face.`,
    table: { columns: ["Defense", "Faces", "TDs allowed vs avg", "TDs/game allowed", "Games"],
      rows: rows.map((x) => [x.opp, `${x.team} (${gameLabel(x.gid)})`, `${x.mult >= 1 ? "+" : ""}${Math.round((x.mult - 1) * 100)}%`, x.tdpg != null ? num1(x.tdpg) : "–", x.games ?? "–"]) },
    notes: ["Small samples early in the season are pulled toward average, so extreme numbers are shrunk. The full splits are on the Defenses page."],
    followups: [`Top ${name} to score this week`, worst ? `Best matchups for ${name}` : `Toughest defenses for ${name}`],
  };
}

/** Games ranked by projected points (from the betting spread and total). */
export function answerGames(d: AskData, f: Filters, lowest = false): Answer {
  const g = new Map<string, Record<string, number>>();
  for (const r of d.td) {
    if (!r.game_id || typeof r.features?.team_implied_total !== "number") continue;
    if (f.day != null && dayOf(r) !== f.day) continue;
    const x = g.get(r.game_id) ?? {};
    x[r.team] = r.features.team_implied_total;
    g.set(r.game_id, x);
  }
  const rows = [...g].map(([gid, t]) => ({ gid, t, total: Object.values(t).reduce((a, b) => a + b, 0) })).filter((x) => Object.keys(x.t).length === 2)
    .sort((a, b) => (lowest ? a.total - b.total : b.total - a.total));
  if (!rows.length) return { title: "No game lines", summary: "Spreads and totals are not available for this week yet.", notes: [], followups: [] };
  return {
    title: lowest ? "Lowest-scoring games this week" : "Highest-scoring games this week",
    summary: "Projected points for each team, from the betting spread and total. More projected points means more touchdowns and yards to go around.",
    table: { columns: ["Game", "Projected total", "Team points"], rows: rows.map((x) => [gameLabel(x.gid), num1(x.total), Object.entries(x.t).map(([k, v]) => `${k} ${num1(v)}`).join(", ")]) },
    notes: [], followups: [`Top TD scorers in the ${gameLabel(rows[0].gid)} game`, "Safest 3-leg parlay"],
  };
}

/** Highest (or lowest) projections in a market. */
export function answerLeaders(d: AskData, market: string, n: number, f: Filters, lowest = false): Answer {
  const rows = (d.props[market]?.rows ?? []).filter((r) => r.eligible && propPlays(d, r, market) && keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id }))
    .sort((a, b) => (lowest ? a.median - b.median : b.median - a.median)).slice(0, n);
  if (!rows.length) return none(d, `No ${market} projections`, f);
  const label = d.props[market].label;
  return {
    title: `${lowest ? "Lowest" : "Highest"} projected ${lc(label)}${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: "This week's projection (the middle outcome) with the range he lands in 8 times out of 10.",
    table: { columns: ["Player", "Team", "Opp", "Projection", "8 in 10 games", "Last 3 avg"], rows: rows.map((r) => [r.player_name, r.team, r.opponent, num1(r.median), `${num1(r.q10)}–${num1(r.q90)}`,
      r.evidence?.[`${statOf(market)}_l3`] != null ? num1(r.evidence[`${statOf(market)}_l3`] as number) : "–"]) },
    notes: [], followups: [`Best ${lc(label)} overs`, `${lc(label)} unders`],
  };
}

const GLOSSARY: [RegExp, string, string][] = [
  [/\b(tier|strong|solid|lean|coin flip|long shot)\b/, "Confidence tiers", "Tiers group picks by the model's chance: for props Strong is 65%+, Solid 58–65%, Lean 53–58%, Coin flip under 53%; for anytime TD Strong is 50%+, Solid 35–50%, Lean 20–35%, Long shot under 20%. Each tier shows how often past picks in that range hit on weeks the model never saw."],
  [/\b(edge|value|ev|expected value)\b/, "Edge", "Edge is our chance minus the chance implied by the best US sportsbook price. A 40% chance at +200 (33% implied) is a +7 point edge. The site flags 3 points or more; expected return is chance × decimal price − 1."],
  [/\b(xtd|expected (tds?|touchdowns?))\b/, "xTD (expected touchdowns)", "xTD turns every carry and target into a touchdown probability based on where on the field it happened, learned from every play since 2018. A player with 3.0 xTD and 1 TD has been unlucky; his chance already credits the opportunity."],
  [/\b(due)\b/, "Due", "Due means at least 1.5 fewer TDs this season than his carries and targets predicted. Due players have scored about 28% of the time next game vs a 21% rate so far, close to what the model already gives them."],
  [/\b(usual line)\b/, "Usual line", "When no book line is loaded, props use the player's usual line: his recent median rounded down plus 0.5. The backtests grade against that same line."],
  [/\b(score out of 10|out of 10|confidence score)\b/, "Scores out of 10", "On the props page each player gets an under and an over score: the model's chance of that side times 10. They always add to 10, and the bigger one is the lean."],
  [/\b(walk.?forward|backtest|tested|validated)\b/, "Walk-forward testing", "Each past week was predicted using only games before it, then graded. A model goes live only if it beats simple baselines on those unseen weeks and its chances match how often things happened."],
  [/\b(hit rate)\b/, "Hit rate", "Hit rate is how often he cleared a line in his recent games. It describes the past; the model's chance is the forecast for this week, which also weighs the matchup, role and game script."],
  [/\b(how do you (make|pick|choose|decide|come up|get|build)|how does (the|your|it) (model|site|work)|how are (picks|chances) (made|picked)|methodology|where do (the|your) (picks|numbers) come)\b/, "How picks are made",
    "Every chance comes from models trained on every game since 2018, with the last two seasons counting most. They use each player's role (snaps, targets, carries, red-zone work), recent form, the opponent's defense against his position, the betting line's implied team points, and whether he is due. Prop chances also blend in a 5,000-run simulation of each game where that proved more accurate. Every model was tested week by week on games it had never seen, and only picks from tiers that hit 50%+ in that testing are suggested."],
  [/\b(5 ?000|five thousand|game sim|simulate the game|simulation of)\b/, "The 5,000-game simulation",
    "Each game is played out 5,000 times: team pass and run volume, who gets the targets and carries, catches and yards against this defense, with a quarterback's yards equal to his receivers' total. Where that beat the model alone on unseen weeks (receptions, receiving yards, rushing yards, carries, rush + receiving yards), the two are blended."],
  [/\b(simulat\w*|correlat\w*|parlay odds)\b/, "Simulations", "Two kinds. Every game is played out 5,000 times (team volume, who gets the targets and carries, yards against this defense), and that simulation is blended into prop chances where it proved more accurate on unseen weeks. Parlays are then simulated 40,000 times. Legs in the same game move together the way they have historically (a QB's yards and his receiver's catches), because that tested better than treating them as independent."],
  [/\b(projection|median|range)\b/, "Projection and range", "The projection is the middle outcome: half his outcomes land above it, half below. The range is where he lands 8 times out of 10."],
];
export function answerGlossary(q: string): Answer | null {
  const hits = GLOSSARY.filter(([re]) => re.test(q));
  if (!hits.length) return null;
  return { title: hits.map((h) => h[1]).join(" · "), summary: hits[0][2], notes: hits.slice(1).map((h) => `${h[1]}: ${h[2]}`), followups: ["How accurate is the model?", "Top 5 TD scorers"] };
}

/* ------------------------------------------------------------------ question parsing */
export const EXAMPLES = [
  "Give me one TD scorer from each game this week",
  "Who will fall short this week?",
  "Top 5 TD scorers",
  "Safest 3-leg parlay",
  "Best value bets this week",
  "Best WR receiving yards overs",
  "Who scores in the Thursday game?",
  "Longshot TD picks",
  "Who is due for a TD?",
  "What props have a 100% hit rate?",
  "Best matchups for WRs this week",
  "Highest scoring games this week",
  "Gibbs vs Henry",
  "Why are these your top picks?",
  "How accurate is the model?",
];

export type Parsed = { intent: string; n?: number; market?: string; anyMarket?: boolean; noTd?: boolean; side?: "over" | "under"; line?: number; filters: Filters; players: string[]; value: boolean; sameGame: boolean; ambiguous?: string[]; price?: number; unknown?: string };

// Last names that are also everyday words only count when capitalised ("Will Swift score?", not "likely to score").
const COMMON = new Set(["likely", "love", "will", "hill", "white", "young", "brown", "rice", "cook", "best", "king", "price", "golden", "hunt",
  "sweet", "bell", "banks", "mills", "wise", "little", "strong", "hope", "chase", "ward", "still", "power", "swift", "waller", "allen", "james",
  "parsons", "moore", "jones", "smith", "williams", "johnson", "davis", "taylor", "thomas", "jackson", "harris", "scott", "green", "carter",
  "wilson", "lamb", "mann", "field", "fields", "pierce", "worthy", "london", "nation", "god", "goff", "able", "bowers", "warren", "washington",
  "cash", "money", "lock", "locks", "legs", "score", "scorer", "pick", "picks", "game", "week", "over", "under", "value", "parlay"]);

// Nicknames people type, mapped to the full name.
const NICKNAMES: [RegExp, string][] = [[/\bcmc\b/, "christian mccaffrey"], [/\bjsn\b/, "jaxon smith njigba"], [/\b(arsb|amon ra|sun god)\b/, "amon ra st brown"],
  [/\bkw3\b/, "kenneth walker"], [/\bmhj\b/, "marvin harrison"], [/\bbtj\b/, "brian thomas"], [/\bjjm\b/, "jj mccarthy"], [/\bhollywood\b/, "marquise brown"],
  [/\bbig dog\b/, "derrick henry"], [/\bking henry\b/, "derrick henry"], [/\btk\b/, "travis kelce"]];
// Words that can sit right before a last name without being a different first name ("Will Swift score", "is Henry a lock").
const LEADERS = new Set(["will", "is", "does", "can", "should", "why", "how", "what", "who", "and", "or", "vs", "versus", "compare", "explain", "about", "on", "for",
  "with", "than", "like", "think", "take", "bet", "hammer", "fade", "the", "a", "an", "of", "to", "has", "have", "did", "do", "if", "but", "rate", "trust", "give", "me", "rams", "lions"]);

function findPlayers(d: AskData, q: string, raw = q): { ids: string[]; ambiguous: string[] } {
  for (const [re, full] of NICKNAMES) if (re.test(q)) q = q.replace(re, full);
  const caps = new Set(raw.split(/[^A-Za-z'.-]+/).filter((w) => /^[A-Z]/.test(w)).map((w) => norm(w)));
  const qw = q.trim().split(" ");
  const names = new Map<string, string>();
  for (const r of d.td) names.set(r.player_id, r.player_name);
  for (const { rows } of Object.values(d.props)) for (const r of rows) if (!names.has(r.player_id)) names.set(r.player_id, r.player_name);
  const words = new Set(q.split(" "));
  const full: string[] = [], byLast = new Map<string, string[]>(), byFirst = new Map<string, string[]>();
  for (const [id, name] of names) {
    const n = norm(name).replace(/\b(jr|sr|ii|iii|iv)\b/g, "").trim();
    if (n.length > 4 && q.includes(n)) { full.push(id); continue; }
    const parts = n.split(" ");
    const last = parts[parts.length - 1], first = parts[0];
    if (last.length >= 4 && words.has(last) && !TEAMS[last] && (!COMMON.has(last) || caps.has(last))) {
      // "Josh Allen" names someone else, not Braelon Allen: a capitalised word right before the last name has to be his first name.
      const before = qw[qw.indexOf(last) - 1];
      if (!before || parts.includes(before) || LEADERS.has(before) || !caps.has(before) || TEAMS[before]) byLast.set(last, [...(byLast.get(last) ?? []), id]);
    }
    if (parts.length > 1 && first.length >= 4 && words.has(first) && !TEAMS[first] && !COMMON.has(first) && !LEADERS.has(first)) byFirst.set(first, [...(byFirst.get(first) ?? []), id]);
  }
  if (full.length) {
    // "Kyren Williams or Bijan": keep the full-name match and add anyone else named, ignoring words inside the full names.
    const used = new Set(full.flatMap((id) => norm(names.get(id) as string).split(" ")));
    const extra = [...byLast.entries(), ...byFirst.entries()].filter(([w, list]) => list.length === 1 && !used.has(w) && !full.includes(list[0])).map(([, list]) => list[0]);
    return { ids: [...new Set([...full, ...extra])], ambiguous: [] };
  }
  // A first name only counts when one player has it ("Saquon", "Puka", "Bijan") and the word was not already a last name.
  for (const [first, list] of byFirst) if (list.length === 1 && !byLast.has(first) && ![...byLast.values()].flat().includes(list[0])) byLast.set(`first:${first}`, list);
  const ids: string[] = [], ambiguous: string[] = [];
  for (const [, list] of byLast) {
    if (list.length === 1) ids.push(list[0]);
    else {
      // Several players share the last name: keep the one with the highest TD chance, list the rest.
      const ranked = list.map((id) => ({ id, p: d.td.find((r) => r.player_id === id)?.p_model ?? 0 })).sort((a, b) => b.p - a.p);
      ids.push(ranked[0].id);
      ambiguous.push(...ranked.slice(1, 4).map((x) => names.get(x.id) as string));
    }
  }
  return { ids, ambiguous };
}

/** "Why is DET favored", "who wins Bears Packers", "break down KC at BUF": a team-level write-up. */
const MATCHUP = /\b(why|explain\w*|favou?red|favou?rites?|underdogs?|who (wins|will win|should win|takes it)|winner|predict\w*|preview|break ?down|analy[sz]\w*|write ?up|deep dive|thoughts|your take|tell me about|compare|comparison|edge|better team|who('?s| is) better|how (do|does) .* match up)\b/;
const WHY_PICKS = /\b(why|explain\w*|reasons?|reasoning|how come|what makes|justify|based on what|case for|break ?down|how confident|confidence in)\b/;

export function parse(d: AskData, raw: string): Parsed {
  const q = ` ${norm(raw)} `;
  const filters: Filters = {};
  for (const [re, p] of POS) if (re.test(q)) { filters.position = p; break; }
  const teams = new Set<string>();
  for (const [k, code] of Object.entries(TEAMS)) if (q.includes(` ${k} `)) teams.add(code);
  for (const tok of raw.split(/[^A-Za-z]+/)) if (tok.length >= 2 && tok === tok.toUpperCase() && CODES.has(tok) && !["QB", "RB", "WR", "TE"].includes(tok)) teams.add(tok);
  if (teams.size) filters.teams = [...teams];
  for (const [k, v] of Object.entries(DAYS)) if (q.includes(` ${k} `) || q.includes(` ${k}s `)) { filters.day = v; break; }
  if (/\b(tonight|tonights)\b/.test(q) && [...gameDays(d).values()].includes(new Date().getDay())) filters.day = new Date().getDay();
  if (/\b(include|including|even|any) (questionable|injured)\b/.test(q)) filters.safe = false;

  let market: string | undefined;
  for (const [m, re] of MARKET_WORDS) if (re.test(q)) { market = m; break; }
  const anyMarket = !market && /\b(any|all|every|whatever) (props?|markets?|bets?|types?|stats?|kinds?|categor(y|ies))\b|\bany prop\b|\bacross (all )?(markets|props)\b|\b(doesnt|does not|dont) (have to|need to) be (a )?(td|touchdown)/.test(q);
  const td = /\b(tds?|touchdowns?|score|scores|scorer|scorers|scoring|anytime|find the end ?zone|endzone|end zone)\b/.test(q);
  if (td && market && !["pass_tds"].includes(market) && !/(yards|yds|receptions|catches|carries|completions|attempts)/.test(q)) market = undefined;
  const side = /\b(unders?|less than|fewer|stay under)\b/.test(q) ? "under" : /\b(overs?|more than|at least|go over|exceed)\b/.test(q) ? "over" : undefined;
  // "throw 2 touchdowns", "2+ passing TDs": a passing-TD line.
  const ptd = q.match(/\b(?:throws?|throwing|toss(?:es)?)\s+(?:for\s+)?(\d|two|three|four)\+?\s+(?:or more\s+)?(?:tds?|touchdowns?|tddds?)\b/);
  if (ptd) market = "pass_tds";

  // "250 passing yards", "throw for 300", "100+ rushing yards", "6+ catches", "over 59.5": a line, not a count.
  let line: number | undefined;
  const lm = q.match(/\b(?:over|under|at least|more than|fewer than|less than|for|clear|hit|reach|get)\s+(\d+(?:\.\d)?)\b/) ?? q.match(/\b(\d+(?:\.\d)?)\s*(?:\+\s*)?(?:or more\s+)?(?:pass(ing)?|rush(ing)?|rec(eiving)?|receptions?|catches|carries|completions|yards|yds)/);
  if (ptd && !lm) line = (NUM[ptd[1]] ?? Number(ptd[1])) - 0.5;
  if (lm) {
    const v = Number(lm[1]);
    line = Number.isInteger(v) ? v - 0.5 : v;
    if (!market) market = /\b(throw|pass)/.test(q) ? "pass_yards" : /\b(run|rush)/.test(q) ? "rush_yards" : /\b(catch|receiv)/.test(q) && v >= 15 ? "rec_yards" : market;
    if (!market && v >= 15) market = filters.position === "QB" ? "pass_yards" : filters.position === "RB" ? "rush_yards" : filters.position ? "rec_yards" : undefined;
    if (!market) line = undefined;
  }
  let n: number | undefined;
  // "from all 14 games" sizes the slate, not the answer.
  const qn = q.replace(lm?.[0] ?? "@@", " ").replace(ptd?.[0] ?? "@@", " ").replace(/[+-]\d{3,4}\b/g, " ").replace(/\b(all |the |of |these |this weeks )?(\d{1,2}|[a-z]+teen|ten|eleven|twelve) (games|matchups)\b/g, " ");
  const dm = qn.match(/\b(\d{1,2})\b/);
  if (dm) n = Number(dm[1]);
  else for (const [w, v] of Object.entries(NUM)) if (new RegExp(`\\b${w}\\b(?! (each|every|per)\\b)`).test(qn) && w !== "a") { n = v; break; }
  if (n == null && /\b(the|a|one|single) (single )?(safest|surest|best|most likely|top|strongest|highest rated|top rated|highest) (pick|bet|play|leg|prop|lock)\b(?!s)|\b(safest|surest) (pick|bet|play|leg|prop|lock)\b(?!s)/.test(qn)) n = 1;
  const value = /\b(value|edges?|ev|plus ev|\+ev|beat(ing)? the books?|mispriced|soft lines?|overlay|bang for)\b/.test(q);
  const sameGame = /\b(same ?game|sgp|in this game|in the game)\b/.test(q) || (teams.size > 0 && /\bparlay\b/.test(q));
  const pl = findPlayers(d, q, raw);
  // A capitalised "First Last" that matches nobody playing this week (a bye, an injury, a typo): say so instead of guessing.
  let unknown: string | undefined;
  if (!pl.ids.length) {
    const GENERIC = /^(night|football|game|games|parlay|picks?|props?|bets?|week|td|tds|touchdown|yards|receptions|over|under|line|lines|hit|rate|value|sunday|monday|thursday|saturday|bowl|day|leg|legs|lock|locks|scorer|scorers)$/;
    for (const m of raw.matchAll(/\b([A-Z][a-z'.]+(?:-[A-Z][a-z]+)?)\s+([A-Z][a-z'.]+(?:-[A-Z][a-z]+)?)\b/g)) {
      const a = norm(m[1]), b = norm(m[2]);
      if (LEADERS.has(a) || TEAMS[a] || TEAMS[b] || GENERIC.test(a) || GENERIC.test(b) || DAYS[a] != null || COMMON.has(a)) continue;
      unknown = `${m[1]} ${m[2]}`; break;
    }
  }
  // "prop" without a named stat means any market, and so does a generic "safest/best pick" with no TD wording.
  // Generic asks ("best bets", "your locks", "who should I bet on", "Thursday picks") draw from every market, like the home page.
  const anyM = anyMarket || (!td && !market && (/\bprops?\b/.test(q)
    || /\b(picks?|bets?|plays?|legs?|locks?|bet on|recommend(ations?)?)\b/.test(q) || /\bwho should i\b/.test(q)));
  const noTd = /\b(no|not|non|without|excluding|except|besides|other than) (an? )?(anytime )?(tds?|touchdowns?)\b/.test(q) || (!td && /\bprops?\b/.test(q));
  // "Swift at -160", "is +250 worth it": a price to check against our chance.
  const priceM = raw.match(/(?:^|[\s(@])([+-]\d{3,4})\b/);
  const price = priceM ? Number(priceM[1]) : undefined;
  const base = { n, market, anyMarket: anyM || noTd, noTd, side: line != null && !side ? "over" as const : side, line, filters, players: pl.ids, value, sameGame, ambiguous: pl.ambiguous, price, unknown } as const;

  if (/\b(what can you|help me|how do i use|what do you know)\b/.test(q)) return { ...base, intent: "help" };
  if ((!pl.ids.length || /\b(mean|meaning|define)\b/.test(q)) && !/\b(best|top|safest|give me|show me)\b/.test(q) && /\b(what (does|do|is|are)|whats|define|meaning|mean|how do you|how does (the|your|it)|how are)\b/.test(q) && answerGlossary(q)) return { ...base, intent: "glossary" };
  if (!pl.ids.length && teams.size && price == null && (MATCHUP.test(q) || (teams.size >= 2 && /\b(or|better)\b/.test(q)))) return { ...base, intent: "matchup" };
  if (!pl.ids.length && !teams.size && WHY_PICKS.test(q) && /\b(picks?|bets?|plays?|locks?|legs?|best|top|safest|these|them|your)\b/.test(q)) return { ...base, intent: "whypicks" };
  if (pl.ids.length && price != null) return { ...base, intent: "price" };
  if (pl.ids.length && line != null && market) return { ...base, intent: "playerline" };
  if (pl.ids.length && /\b(alt(ernate)? lines?|ladder|every line|all (the )?lines|how often|hit rates?|how many times)\b/.test(q)) return { ...base, intent: "ladder" };
  if (/\b\d{2,3} ?(%|percent)/.test(raw.toLowerCase()) || /\bhit rates?\b|\bperfect (record|hit)|\bnever missed|\bhasnt missed|\b(cleared|hit|gone over|went over) (it |the line )?(in )?every (single )?(game|time|week)|\bhot streak|\bon fire\b|\bstreaks?\b|\bevery (single )?game (this|last)/.test(q)) return { ...base, intent: "hitrate" };
  if (!pl.ids.length && /\b(defen[sc]es?|matchups?|d vs|against the pass|against the run)\b/.test(q) && /\b(worst|best|toughest|easiest|weakest|strongest|allow|allows|allowed|most|fewest|good|bad|soft|stingiest|hardest)\b/.test(q)) return { ...base, intent: "defense" };
  if (/\b(highest|most|lowest|fewest|least) (scoring|points|projected (total|points))|\bshootouts?\b|\bgame totals?\b|\bprojected totals?\b|\bwhich games? .*(score|points|total)|\bhighest total|\blowest total/.test(q)) return { ...base, intent: "games" };
  if (market && !pl.ids.length && /\b(most|highest|lowest|fewest|leaders?|projected|projections?)\b/.test(q) && !/\b(over|under|chance|likely|safest|parlay|value)\b/.test(q) && line == null) return { ...base, intent: "leaders" };
  if (pl.ids.length && /\b(why|explain|reasons?|reasoning|how come|what makes|what is behind|whats behind|justify|based on what)\b/.test(q)) return { ...base, intent: "why" };
  if (/\b(accura|track record|record|hit rate|how good is (the|your) model|trust (the|your|this|it|you|these)|can i trust|reliable|calibrat|how often .* (hit|right)|win rate|success rate|guarantee\w*|sure thing|locks? really)/.test(q)) return { ...base, intent: "record" };
  if (/\b(injur\w*|questionable|doubtful|hurt|out this week|inactive)\b/.test(q) && !/\b(parlay|best|top)\b/.test(q)) return { ...base, intent: "injuries" };
  if (/\b(avoid|fade|stay away|overpriced|overrated|traps?|worst bets?|bad bets?)\b/.test(q)) return { ...base, intent: "avoid" };
  if (/\b(each|every|per|all) (game|matchup|contest)s?\b|\bfrom every\b|\bgame by game\b|\beach of the games\b/.test(q)) return { ...base, intent: "pergame" };
  if (/\b(parlay|parlays|legs?|slip|accumulator|multi)\b/.test(q)) return { ...base, intent: "parlay" };
  if (/\b(fall short|come up short|struggle|won'?t (hit|reach|get)|held (in check|under)|shut ?down|bust|busts|busting|unders?)\b/.test(q) && !/\b(parlay|each|every)\b/.test(q)) return { ...base, intent: "unders" };
  if ((anyM || noTd) && !/\b(parlay|parlays|value|unders?|fall short)\b/.test(q) && !pl.ids.length) return { ...base, intent: "any" };
  if (/\b(longshots?|long shots?|sleepers?|dark ?horse|big payout|plus money|underdogs? to score|lottery)\b/.test(q)) return { ...base, intent: "sleepers" };
  if (pl.ids.length && !/\b(top|best|safest|most likely|highest)\b/.test(q) && line == null) return { ...base, intent: "player" };
  if (/\b(due|overdue|bounce ?back|unlucky|positive regression|buy ?low)\b/.test(q) && !/\bparlay\b/.test(q)) return { ...base, intent: "due" };
  if (value) return { ...base, intent: "value" };
  if (market) return { ...base, intent: "props" };
  if (teams.size && (teams.size > 1 || /\b(vs|versus|game|matchup|against|at)\b/.test(q) || !(td || /\b(top|best|safest|picks?|bets?|who)\b/.test(q)))) return { ...base, intent: "game" };
  if (teams.size === 1) filters.teamOnly = true;
  if (td || /\b(top|best|safest|most likely|locks?|highest|picks?|bets?|who should i|recommend|surest|confident)\b/.test(q)) return { ...base, intent: "top" };
  if (pl.ids.length) return { ...base, intent: "player" };
  return { ...base, intent: "help" };
}

export function answer(d: AskData, raw: string): Answer {
  const p = parse(d, raw);
  const f = p.filters;
  let a: Answer;
  if (p.unknown && ["player", "props", "top", "why", "ladder", "any", "help"].includes(p.intent)) {
    return { title: `No numbers for ${p.unknown} this week`, summary: `${p.unknown} has no projection this week. He may be on a bye, injured or inactive, or the name may be spelled differently. Try his last name alone.`,
      notes: [], followups: ["Top 5 TD scorers", "Safest pick, any prop", "Injury report"] };
  }
  switch (p.intent) {
    case "price": a = answerPriceCheck(d, p.players.slice(0, 3), p.price as number, p.market ?? (/\b(td|touchdown|score|scorer|anytime)/.test(norm(raw)) || !p.line ? "td" : undefined), p.side, p.line); break;
    case "playerline": a = answerPlayerLine(d, p.players.slice(0, 3), p.market as string, p.side ?? "over", p.line as number); break;
    case "record": a = answerRecord(d); break;
    case "injuries": a = answerInjuries(d, f); break;
    case "pergame": a = answerPerGame(d, p.market ?? (p.noTd ? "any-props" : p.anyMarket ? "any" : "td"), f); break;
    case "parlay": a = answerParlay(d, Math.min(Math.max(p.n ?? 3, 2), 8), f, { market: p.market ?? (/\b(tds?|touchdowns?|scor|anytime)/.test(norm(raw)) && !p.anyMarket ? "td" : "any"), value: p.value, sameGame: p.sameGame, side: p.side }); break;
    case "sleepers": a = answerSleepers(d, p.n ?? 6, f); break;
    case "due": a = answerDue(d, p.n ?? 8, f); break;
    case "glossary": a = answerGlossary(norm(raw)) as Answer; break;
    case "ladder": a = answerLadder(d, p.players, p.market, Number(norm(raw).match(/\blast (\d{1,2})\b/)?.[1] ?? 8)); break;
    case "hitrate": {
      const qq = norm(raw);
      const hot = /\b(hot|streak|on fire)\b/.test(qq);
      const pctm = raw.toLowerCase().match(/\b(\d{2,3}) ?(?:%|percent)/);
      const win = qq.match(/\blast (\d{1,2})\b/);
      const season = /\b(this season|all season|every game|every week)\b/.test(qq);
      a = answerHitRates(d, p.n ?? 15, f, { threshold: pctm ? Math.min(1, Number(pctm[1]) / 100) : 1, window: win ? Math.min(16, Number(win[1])) : hot ? 5 : season ? 16 : 8, fallback: !pctm,
        side: p.side ?? (/\bunders?\b/.test(qq) ? "under" : undefined), markets: p.market ? [p.market] : undefined });
      break;
    }
    case "defense": a = answerDefense(d, f.position, /\b(toughest|hardest|best defen[sc]es?|strongest|fewest|stingiest|avoid|good defen)/.test(norm(raw)), p.n ?? 10); break;
    case "games": a = answerGames(d, f, /\b(lowest|fewest|least)\b/.test(norm(raw))); break;
    case "leaders": a = answerLeaders(d, p.market as string, p.n ?? 10, f, /\b(lowest|fewest)\b/.test(norm(raw))); break;
    case "why": a = answerWhy(d, p.players, p.market ?? (/\b(td|touchdown|score)/.test(norm(raw)) ? "td" : undefined), /\bunder\b/.test(norm(raw)) ? "under" : /\bover\b/.test(norm(raw)) ? "over" : undefined); break;
    case "any": a = answerAny(d, Math.min(p.n ?? 5, 25), f, p.noTd); break;
    case "player": a = answerPlayer(d, p.players.slice(0, 3), p.market ?? (/\b(td|touchdown|score)/.test(norm(raw)) ? "td" : undefined)); break;
    case "avoid": a = answerAvoid(d, p.n ?? 8, f); break;
    case "unders": a = p.line != null && p.market ? answerProps(d, p.market, p.n ?? 10, f, "under", p.line) : answerUnders(d, p.n ?? 8, f, p.market ? [p.market] : undefined); break;
    case "value": a = answerValue(d, p.n ?? 8, f, p.market ? [p.market] : /\b(tds?|touchdowns?|scor)/.test(norm(raw)) ? ["td"] : undefined); break;
    case "props": a = answerProps(d, p.market as string, p.n ?? (p.line != null ? 10 : 8), f, p.side, p.line); break;
    case "game": a = answerGame(d, f.teams as string[], f); break;
    case "matchup": a = answerMatchup(d, f.teams as string[]); break;
    case "whypicks": a = answerWhyPicks(d, /\b(pick|bet|play|lock|leg)\b(?!s)/.test(norm(raw)) && !/\b(picks|bets|plays|locks|legs|these|them)\b/.test(norm(raw)) ? 1 : Math.min(p.n ?? 3, 5), f, p.noTd); break;
    case "top": a = answerTop(d, Math.min(p.n ?? 5, 25), f); break;
    default:
      return { title: "I can help with that if you phrase it like one of these", summary: "Ask about touchdown scorers, player props, parlays, value against the books, a team, a game, a player, or the model's record. Filters like position (WR), team (Bears) and day (Thursday) work in any question.", notes: [], followups: EXAMPLES };
  }
  if (p.ambiguous?.length) a.notes = [`Several players match that name; showing the one most likely to matter. Others: ${p.ambiguous.join(", ")}.`, ...a.notes];
  return a;
}

/** Compact, number-only view of the week for the AI mode's tools. */
export const pickJson = (p: Pick) => ({ player: p.name, team: p.team, opponent: p.opp, position: p.pos, game: gameLabel(p.game_id), bet: p.label,
  our_chance: Number(p.p.toFixed(3)), best_price: p.price != null ? fmtPrice(p.price) : null, book: p.book ?? null,
  price_implied_chance: p.price != null ? Number((1 / dec(p.price)).toFixed(3)) : null, edge: p.edge != null ? Number(p.edge.toFixed(3)) : null,
  tier: p.tier ?? null, tier_past_hit_rate: p.tierRate != null ? Number(p.tierRate.toFixed(3)) : null, note: p.note ?? null,
  projection: p.median != null ? { median: p.median, range_10_90: p.range } : null, reasons: p.reasons ?? null,
  factors_against: p.against ?? null, key_numbers: p.facts ?? null,
  due: p.due ? { tds: p.due.actual, expected_tds: Number(p.due.expected.toFixed(2)), games: p.due.games } : null,
  line_source: p.lineSource === "usual" ? "player's usual line (no book line loaded)" : p.line != null ? "book line" : null });

export const answerJson = (a: Answer) => ({ title: a.title, summary: a.summary, picks: a.picks?.map(pickJson),
  groups: a.groups?.map((g) => ({ title: g.title, picks: g.picks.map(pickJson) })), parlay: a.parlay ?? null,
  projections: a.projections ?? null, table: a.table ?? null, write_up: a.sections ?? null, notes: a.notes });

/* ------------------------------------------------------------------ matchup write-up */
const SCHEME_LABEL: Record<string, string> = { blitz_rate: "blitz rate", pressure_rate: "pressure rate (sack or QB hit)", man_rate: "man coverage", zone_rate: "zone coverage",
  stacked_box_rate: "runs faced with 8+ in the box", light_box_rate: "runs faced with 6 or fewer in the box" };
const f1 = (v: number) => v.toFixed(1);
const POS_SHORT: Record<string, string> = { QB: "QBs", RB: "RBs", WR: "WRs", TE: "TEs" };

/** What one defense has allowed and how it plays, against the league. */
function defenseLines(d: AskData, def: AskDefense, offense: string): string[] {
  const lg = d.defenses?.league;
  const out: string[] = [];
  if (!def.available) return [`${def.defense}: no completed games before this week.`];
  out.push(`${def.defense} defense (${def.games} games before this week): ${def.points_allowed_pg != null ? `${f1(def.points_allowed_pg)} points` : ""}, ${f1(def.offensive_tds_allowed_pg)} offensive TDs and ${f1(def.xtd_allowed_pg)} expected TDs allowed a game`
    + `${def.rz_td_rate_allowed != null ? `; red-zone trips end in a TD ${pct(def.rz_td_rate_allowed)} of the time${lg?.rz_td_rate != null ? ` (league ${pct(lg.rz_td_rate)})` : ""}` : ""}.`);
  if (lg) {
    const pos = (["RB", "WR", "TE", "QB"] as Pos[]).filter((p) => def.positions[p] && lg[p]?.tds_pg).map((p) => {
      const m = def.positions[p].tds_pg / (lg[p] as { tds_pg: number }).tds_pg;
      return { p, m, text: `${POS_SHORT[p]} ${m >= 1 ? "+" : ""}${Math.round((m - 1) * 100)}%` };
    });
    if (pos.length) {
      out.push(`TDs allowed by position vs league average: ${pos.map((x) => x.text).join(", ")}.`);
      const soft = pos.filter((x) => x.m >= 1.2).map((x) => POS_SHORT[x.p]);
      if (soft.length) out.push(`${offense} gets a soft spot: ${def.defense} has given up the most against ${soft.join(" and ")}.`);
    }
  }
  const sc = def.scheme?.rates, sl = d.defenses?.scheme_league;
  if (sc && sl) {
    const parts = Object.keys(SCHEME_LABEL).filter((k) => sc[k] != null && sl[k] != null).map((k) => `${SCHEME_LABEL[k]} ${pct(sc[k])} (league ${pct(sl[k])})`);
    if (parts.length) out.push(`How it plays: ${parts.join(", ")}${def.scheme?.top_shell?.[0] ? `; most-used shell ${def.scheme.top_shell[0]}${def.scheme.top_shell[1] != null ? ` (${pct(def.scheme.top_shell[1])})` : ""}` : ""}.`);
  }
  return out;
}

/** Why one team is favored: the line's implied points, both defenses, schemes, injuries and the players most likely to produce. */
export function answerMatchup(d: AskData, teams: string[]): Answer {
  const gid = d.td.find((r) => r.game_id && teams.includes(r.team) && (teams.length < 2 || teams.includes(r.opponent ?? "")))?.game_id
    ?? d.td.find((r) => r.game_id && teams.includes(r.team))?.game_id;
  if (!gid) return { title: `No game for ${teams.join("/")} this week`, summary: "That team has no game with published chances this week (a bye, or the week is not built yet).", notes: [], followups: ["Highest scoring games this week"] };
  const { away, home } = gameTeams(gid);
  const implied = (t: string) => {
    const v = d.td.find((r) => r.team === t && r.game_id === gid && typeof r.features?.team_implied_total === "number")?.features.team_implied_total;
    if (typeof v === "number") return v;
    for (const { rows } of Object.values(d.props)) {
      const r = rows.find((x) => x.game_id === gid && (x.team === t ? x.evidence?.team_implied_total != null : x.opponent === t && x.evidence?.opp_implied_total != null));
      if (r) return (r.team === t ? r.evidence!.team_implied_total : r.evidence!.opp_implied_total) as number;
    }
    return null;
  };
  const ia = implied(away), ih = implied(home);
  const fav = ia != null && ih != null ? (ih >= ia ? home : away) : null;
  const dog = fav === home ? away : home;
  const line: string[] = [];
  if (ia != null && ih != null) {
    line.push(Math.abs(ih - ia) < 0.5 ? `The betting line has it about even: ${away} ${f1(ia)} and ${home} ${f1(ih)} implied points, total ${f1(ia + ih)}.`
      : `${fav} is favored by about ${f1(Math.abs(ih - ia))}: the spread and total imply ${away} ${f1(ia)} and ${home} ${f1(ih)} points (total ${f1(ia + ih)}).`);
  } else line.push("No spread or total is loaded for this game yet.");
  line.push("The Lab does not model NFL spreads: the favorite is the betting market's call, and its implied points feed every player chance here. Below is what our data shows behind it.");
  const def = (t: string) => d.defenses?.teams.find((x) => x.defense === t);
  const sides: Section[] = [];
  for (const [off, dfn] of [[fav ?? away, dog ?? home], [dog ?? home, fav ?? away]] as const) {
    const x = def(dfn);
    sides.push({ title: `${off} offense vs ${dfn} defense`, lines: [
      implied(off) != null ? `${off} is expected to score ${f1(implied(off) as number)}.` : "",
      ...(x ? defenseLines(d, x, off) : [`${dfn} defense numbers are not loaded.`])] });
  }
  if (fav) {
    const a = def(dog), b = def(fav);
    if (a?.available && b?.available && a.points_allowed_pg != null && b.points_allowed_pg != null)
      sides.unshift({ title: `Why ${fav} is favored`, lines: [
        `${dog}'s defense has allowed ${f1(a.points_allowed_pg)} points a game and ${f1(a.xtd_allowed_pg)} expected TDs; ${fav}'s has allowed ${f1(b.points_allowed_pg)} and ${f1(b.xtd_allowed_pg)}.`,
        a.points_allowed_pg > b.points_allowed_pg ? `${fav} has the better defense so far by ${f1(a.points_allowed_pg - b.points_allowed_pg)} points a game, which matches the market making them the favorite.`
          : `${dog} has actually allowed fewer points so far, so the market's lean toward ${fav} rests on more than defense (offense, quarterback, home field or schedule).`,
        `${home} is at home.`] });
  }
  const inj = d.td.filter((r) => r.game_id === gid && status(r)).sort((x, y) => (y.p_model ?? 0) - (x.p_model ?? 0))
    .map((r) => `${r.player_name} (${r.team} ${r.position}): ${status(r)}`);
  const scorers: string[] = [];
  for (const t of [away, home]) {
    const top = tdPool(d, { teams: [t], teamOnly: true }).slice(0, 3);
    if (top.length) scorers.push(`${t}: ${top.map((p) => `${p.name} ${pct(p.p)}${p.tier ? ` (${p.tier})` : ""}`).join(", ")}.`);
  }
  const props = Object.keys(d.props).flatMap((m) => propPool(d, m, { teams: [away, home], teamOnly: true }).slice(0, 2)).sort((x, y) => y.p - x.p).slice(0, 4)
    .map((p) => `${p.name} (${p.team}) ${p.label}: ${pct(p.p)}${p.tier ? `, ${p.tier}${p.tierRate != null ? ` (that tier hit ${pct(p.tierRate)} on unseen weeks)` : ""}` : ""}.`);
  const sections = tidy([
    { title: "The line", lines: line },
    ...sides,
    { title: "Injury report", lines: inj.length ? inj : ["No skill players from either team are on the injury report."] },
    { title: "Most likely touchdown scorers", lines: scorers },
    { title: "Strongest prop sides", lines: props },
    { title: "Good to know", lines: ["Defense numbers count only games before this week; early in the season they rest on few games.",
      d.defenses?.coverage ?? "", "Ask \"why\" about any player here for his full breakdown."] },
  ]);
  return {
    title: `${away} at ${home}${fav ? `: why ${fav} is favored` : ""}`,
    summary: fav ? `${fav} is the betting favorite. Here is what the line, both defenses, the injury report and our player chances say about this game.` : "What our data says about this game.",
    sections, notes: priceNote(d),
    followups: [`${away} ${home} game`, `Safest 2-leg same game parlay ${home}`, ...(tdPool(d, { teams: [away, home], teamOnly: true })[0] ? [`Why ${tdPool(d, { teams: [away, home], teamOnly: true })[0].name}?`] : [])],
  };
}

/** "Why these picks": each of the strongest proven legs with its full breakdown. */
export function answerWhyPicks(d: AskData, n: number, f: Filters, noTd = false): Answer {
  const picks = anyPool(d, f, noTd ? Object.keys(d.props) : undefined).filter((p) => isProven(d, p)).slice(0, n);
  if (!picks.length) return { title: "No proven picks to explain", summary: "Nothing this week reaches a confidence tier that hit 50%+ on unseen weeks, so there is no pick to explain.", notes: [], followups: ["How accurate is the model?"] };
  const sections: Section[] = [];
  const out: Pick[] = [];
  for (const p of picks) {
    const w = answerWhy(d, [p.player_id], p.kind === "td" ? "td" : p.market, p.side === "yes" ? undefined : p.side);
    const x = w.picks?.[0];
    if (!x) continue;
    out.push(x);
    sections.push({ title: `${x.name} (${x.team}): ${x.label}, ${pct(x.p)}`, lines: [
      `Our model gives ${x.name} a ${pct(x.p)} chance${x.kind === "td" ? " to score a rushing or receiving touchdown" : ""} against ${x.opp}.`,
      ...(x.tierData?.rate != null ? [`${x.tier}: picks in that range hit ${pct(x.tierData.rate)} of ${x.tierData.n.toLocaleString()} on unseen weeks.`] : []),
      ...(x.reasons ?? []).map((r) => `For: ${r}`), ...(x.against ?? []).map((r) => `Against: ${r}`), ...(x.facts ?? [])] });
  }
  return { title: out.length === 1 ? `Why ${out[0].name} is the top pick` : `Why these are the top ${out.length} picks`,
    summary: "The strongest proven legs across every market, each with what supports it, what works against it and the numbers behind it.",
    picks: out, sections: tidy(sections), notes: [...noteTier(out), ...priceNote(d)], followups: out.slice(0, 2).map((p) => `Why is ${p.team} favored?`) };
}
