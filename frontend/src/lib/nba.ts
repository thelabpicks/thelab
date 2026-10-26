/* NBA data: JSON files written by `python -m nba.pipeline` (site-data/nba/). The hosted site serves them under
   data/nba/; the desktop app serves the same files at /api/nba/. Nothing here computes a number the engine did not
   publish except over/under chances at a line you type, which use the same published distribution. */
import { useQuery } from "@tanstack/react-query";
import { STATIC } from "./api";
import { pOver, type PropDist } from "./props";
import type { Tier } from "./confidence";
import type { Buckets } from "./sim";

export const NBA_MARKETS: { market: string; label: string; short: string }[] = [
  { market: "points", label: "Points", short: "PTS" },
  { market: "rebounds", label: "Rebounds", short: "REB" },
  { market: "assists", label: "Assists", short: "AST" },
  { market: "threes", label: "Threes made", short: "3PM" },
  { market: "pra", label: "Pts + Reb + Ast", short: "PRA" },
];
export const marketLabel = (m: string) => NBA_MARKETS.find((x) => x.market === m)?.label ?? m;
export const EDGE_MIN = 0.03;
/** Picks and records skip lines under 1.5 (an "under 0.5 threes" on a center is not a real bet); same rule as nba/report.py. */
export const MIN_LINE = 1.5;

export type Offer = { book: string; side: "over" | "under"; line: number; price: number };
export type NbaRow = {
  player_id: string; player_name: string; team: string; opp: string; pos: string; home: number; headshot?: string; game_id: number;
  injury: string | null; injury_note: string | null; out: boolean; market: string; mean: number; q10: number; q90: number;
  line: number; line_source: "book" | "usual"; usual_line: number | null; dist: PropDist | null; p_over: number | null; offers: Offer[];
  recent: number[]; recent_minutes: number[]; due: boolean;
  evidence: { minutes: number; minutes_long: number; per_min: number; opp_mult: number | null; pace: number | null; opp_pace: number | null; rest: number; start_rate: number };
};
export type NbaGame = { game_id: number; date: string; time: string; home: string; away: string; total?: number | null; home_spread?: number | null };
export type Slate = { date: string | null; generated_at: string; games: NbaGame[]; rows: NbaRow[]; odds: { fetched_at: string | null; plan: string | null; props_priced: boolean } };
export type MarketReport = {
  market: string; label: string; validated: boolean; failed_checks: string[]; test_rows: number; test_months: number; first_season: number;
  crps_gain_pct: number; mae: number; baseline_mae: number; over_brier: number; baseline_over_brier: number; coin_brier: number;
  over_ece: number; coverage_10_90: number; lean_n: number; lean_hit_rate: number | null; checks: Record<string, boolean>;
};
export type NbaConfidence = { props: null | { first_season: number; tiers: Tier[]; by_side: { over: Tier[]; under: Tier[] }; note: string;
  by_market: { market: string; label: string; n: number; rate: number; strong_n: number; strong_rate: number | null; unders_strong_rate: number | null; overs_strong_rate: number | null }[] } };
export type NbaCorrelation = { use_correlation: boolean; buckets: Buckets; events?: number; pairs?: number;
  validation?: { pairs: { log_loss_gain: number; gain_ci: [number, number]; months: number; n: number }; triples: { log_loss_gain: number; n: number };
    gate: { checks: { check: string; value: unknown; pass: boolean }[]; passed: boolean } } };
export type NbaDue = { rule: string; markets: Record<string, { label: string; n: number; over_rate: number; model_over: number; beat_projection: number; others_beat_projection: number }> };
export type NbaRecord = { days: number; picks: number; empty_reason?: string; first_date?: string; last_date?: string; tiers?: Tier[];
  by_market?: { market: string; label: string; n: number; rate: number; strong_n: number; strong_rate: number | null }[];
  vs_books?: { picks: number; wins: number; units: number; roi: number | null };
  projection_check?: { market: string; label: string; n: number; avg_miss: number; bias: number; last7_n: number; last7_bias: number }[];
  post_game?: PostGame };
export type PostGame = { n: number; lost?: number; lost_minutes_explain?: number;
  by_market?: { market: string; label: string; n: number; minutes_part: number; rate_part: number; minutes_bias: number }[];
  minutes?: { avg_miss: number; bias: number; players: number }; team_rotation?: { games: number; bias: number; avg_miss: number } | null;
  injury_listed?: { n: number; hit: number | null; minutes_bias: number | null };
  biggest_misses?: { date: string; player_id: string; market: string; line: number; projected: number; actual: number; proj_minutes: number; minutes: number; cause: "minutes" | "production" }[] };
export type NbaStatus = { generated_at: string; season_label: string; slate_date: string | null; slate_games: number; projected_players: number;
  validated_markets: string[]; recency_half_life_seasons: number; injuries_as_of?: string | null;
  team_check?: { use: boolean; test_seasons?: number[]; plain?: TeamCheckScore; adjusted?: TeamCheckScore };
  history: { first_season: number; games: number; player_games: number; last_game_date: string } };
export type TeamCheckScore = { lean_hit: number; strong_hit: number; strong_n: number; avg_miss: number };
export type GameLog = { date: string; opp: string; home: number; minutes: number; starter: number; points: number; rebounds: number; assists: number; threes: number; pra: number };
export type PlayerPage = { player_id: string; player_name: string; team: string; pos: string; headshot?: string; log: GameLog[]; props: NbaRow[] };

const BASE = `${import.meta.env.BASE_URL}data/nba/`;

export async function nbaGet<T>(name: string): Promise<T> {
  const url = STATIC ? BASE + name : `/api/nba/${name}`;
  const r = await fetch(url);
  if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error("NBA data is not published yet.");
  return r.json() as Promise<T>;
}

export function useNba<T>(name: string, enabled = true) {
  return useQuery({ queryKey: ["nba", name], queryFn: () => nbaGet<T>(name), staleTime: 5 * 60_000, enabled });
}

/** Chance of the over at a line: the published one at the published line, otherwise from the distribution. */
export function overAt(r: NbaRow, line: number): number | null {
  if (!r.dist) return null;
  if (line === r.line && r.p_over != null) return r.p_over;
  return pOver(r.dist, line);
}

export type Lean = { side: "over" | "under"; p: number; over: number };
export function leanOf(r: NbaRow, line = r.line): Lean | null {
  const over = overAt(r, line);
  if (over == null) return null;
  return over >= 0.5 ? { side: "over", p: over, over } : { side: "under", p: 1 - over, over };
}

export function nbaTier(c: NbaConfidence | undefined, p: number | null | undefined): Tier | null {
  if (p == null || !c?.props) return null;
  return c.props.tiers.find((t) => p >= t.lo && p < (t.hi >= 1 ? 1.01 : t.hi)) ?? null;
}

const dec = (american: number) => 1 + (american > 0 ? american / 100 : 100 / -american);
export type NbaEdge = { price: number; book: string; implied: number; edge: number };
/** Best price for the lean side at the shown line; an Edge when our chance beats its implied chance by 3+ points. */
export function bestOffer(r: NbaRow, side: "over" | "under", line = r.line): { price: number; book: string } | null {
  return r.offers.filter((o) => o.side === side && o.line === line).reduce<{ price: number; book: string } | null>(
    (b, o) => (!b || dec(o.price) > dec(b.price) ? { price: o.price, book: o.book } : b), null);
}
export function edgeOf(r: NbaRow, lean: Lean | null): NbaEdge | null {
  if (!lean) return null;
  const b = bestOffer(r, lean.side);
  if (!b) return null;
  const implied = 1 / dec(b.price);
  return lean.p - implied >= EDGE_MIN ? { ...b, implied, edge: lean.p - implied } : null;
}

export const fmtPrice = (p: number) => (p > 0 ? `+${p}` : String(p));
export const score10 = (p: number) => (p * 10).toFixed(1);
export const BOOK_NAMES: Record<string, string> = { draftkings: "DraftKings", fanduel: "FanDuel", betmgm: "BetMGM", williamhill_us: "Caesars",
  espnbet: "ESPN BET", fanatics: "Fanatics", betrivers: "BetRivers", hardrockbet: "Hard Rock", ballybet: "Bally Bet", bovada: "Bovada",
  betonlineag: "BetOnline", mybookieag: "MyBookie", betus: "BetUS", lowvig: "LowVig" };
export const bookName = (k: string) => BOOK_NAMES[k] ?? k;

/** Plain-language reasons for a lean, from the evidence the engine published. */
export function nbaReasons(r: NbaRow, lean: Lean): string[] {
  const out: string[] = [];
  const e = r.evidence;
  const label = marketLabel(r.market).toLowerCase();
  const over = lean.side === "over";
  const last = r.recent.slice(0, 10);
  if (last.length >= 5) {
    const above = last.filter((v) => v > r.line).length;
    out.push(`Went over ${r.line} in ${above} of his last ${last.length} games.`);
  }
  if (e.opp_mult != null && Math.abs(e.opp_mult - 1) >= 0.05) {
    const more = e.opp_mult > 1;
    out.push(`${r.opp} allows ${Math.abs(Math.round((e.opp_mult - 1) * 100))}% ${more ? "more" : "fewer"} ${label} per minute to ${r.pos === "G" ? "guards" : r.pos === "C" ? "centers" : "forwards"} than the league average.`);
  }
  if (e.minutes != null && e.minutes_long != null && Math.abs(e.minutes - e.minutes_long) >= 2.5)
    out.push(`Recent minutes ${e.minutes > e.minutes_long ? "up" : "down"}: ${e.minutes.toFixed(0)} lately vs ${e.minutes_long.toFixed(0)} over a longer stretch.`);
  if (e.pace != null && e.opp_pace != null) {
    const pace = (e.pace + e.opp_pace) / 2;
    if (pace >= 102) out.push(`Fast game expected (about ${pace.toFixed(0)} possessions per team).`);
    else if (pace <= 97.5) out.push(`Slow game expected (about ${pace.toFixed(0)} possessions per team).`);
  }
  if (e.rest === 1) out.push("Second night of a back-to-back.");
  out.push(`Projects ${r.mean.toFixed(1)} on average; the line is ${r.line} (${over ? "below" : "above"} that).`);
  return out;
}

/** previous.json: every graded lean of the last three weeks, by day and game. A lean is
 *  [player_id, name, team, market, side, line, chance, projection, actual, won]. */
export type NbaPrevLean = [string, string, string, string, "over" | "under", number, number, number | null, number, 0 | 1];
export type NbaPrevious = { generated_at: string; note?: string;
  days: { date: string; line_source: "book" | "usual"; games: { game_id: number; home: string; away: string; score: [number | null, number | null]; picks: NbaPrevLean[] }[] }[] };
