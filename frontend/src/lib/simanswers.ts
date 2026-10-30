/* Ask the sims: the questions people ask about a game (who scores first, who wins, the best pick), answered from the
   game's 5,000 simulations and shown on the Game Simulations page. Built by scripts/sim-parlays.ts from the same
   posted inputs and seeded runs as the Sim Parlay, once, when the game's sim posts; then locked like the sim. After the
   game the first scorer is graded on ESPN's play-by-play (scripts/sim-grades.ts), with its own record.

   NBA "scores first" is the first field goal (free throws don't count, as on books' first basket markets). NFL is the
   first touchdown; the sims have no defensive or return touchdowns, so a game that opens with one counts as a miss. */
import type { SimPick } from "./gamesims";
import { normName, type SimGrade, type Sport } from "./simgrades";
import type { Leg, RunBox } from "./simparlay";

/** One run as the answers read it: its box score, final score (away, home), and who scored first (NBA: the first field
 *  goal; NFL: the first touchdown) as [team index, box score key], or null when nobody did. */
export type RunFacts = { box: RunBox; score: [number, number]; first: [number, string] | null };
export type Scorer = { team: string; name: string; chance: number };
export type SimAnswers = {
  key: string; sport: Sport; game: string; away: string; home: string; start: string; built_at: string; runs: number;
  /** each team's share of the runs won, and its average points */
  win: Record<string, number>; avg: Record<string, number>;
  /** the likeliest first scorers, most likely first; none: share of runs with no touchdown (NFL) */
  first: Scorer[]; none?: number;
  /** NFL: the likeliest touchdown scorers (any time in the game) */
  anytime?: Scorer[];
  /** The Lab's picks on the game, and the lines the sims hit most often from the books' ladders */
  picks: Pick<SimPick, "who" | "market" | "side" | "line">[];
  sure: Omit<Leg, "actual" | "hit">[];
  /** after the game: who really scored first, and the chance the sims gave him */
  actual?: { team: string; name: string; chance: number; top: boolean } | null;
  graded_at?: string;
};
/** A player the sims played: his team index and his key in the engine's box score. */
type Who = { ti: number; team: string; name: string; key: string };

export const FIRST_SHOWN = 6, ANYTIME_SHOWN = 8, SURE_SHOWN = 2;

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** A game's answers from its runs. players: everyone in the engine's box score with a name (NBA bench line included,
 *  so the shares add up; the page shows it as "a bench player"). */
export function buildAnswers(
  base: Pick<SimAnswers, "key" | "sport" | "game" | "away" | "home" | "start">, players: Who[], runs: RunFacts[],
  picks: SimAnswers["picks"], sure: SimAnswers["sure"], now = new Date(),
): SimAnswers {
  const n = runs.length, teams = [base.away, base.home];
  const name = new Map(players.map((p) => [`${p.ti}|${p.key}`, p]));
  const share = (count: Map<string, number>, shown: number): Scorer[] => [...count]
    .map(([k, c]) => ({ p: name.get(k), c })).filter((x) => x.p)
    .sort((a, b) => b.c - a.c).slice(0, shown).map(({ p, c }) => ({ team: p!.team, name: p!.name, chance: r3(c / n) }));
  const first = new Map<string, number>(), any = new Map<string, number>();
  const wins = [0, 0], pts = [0, 0];
  let none = 0;
  for (const r of runs) {
    if (r.score[0] !== r.score[1]) wins[r.score[0] > r.score[1] ? 0 : 1]++;
    pts[0] += r.score[0]; pts[1] += r.score[1];
    if (r.first) { const k = `${r.first[0]}|${r.first[1]}`; first.set(k, (first.get(k) ?? 0) + 1); } else none++;
    if (base.sport === "nfl") {
      r.box.forEach((t, ti) => { for (const [k, s] of Object.entries(t)) if ((s.rtd ?? 0) + (s.rutd ?? 0) > 0) any.set(`${ti}|${k}`, (any.get(`${ti}|${k}`) ?? 0) + 1); });
    }
  }
  return {
    ...base, built_at: now.toISOString(), runs: n,
    win: Object.fromEntries(teams.map((t, i) => [t, r3(wins[i] / n)])), avg: Object.fromEntries(teams.map((t, i) => [t, r1(pts[i] / n)])),
    first: share(first, FIRST_SHOWN), ...(base.sport === "nfl" ? { none: r3(none / n), anytime: share(any, ANYTIME_SHOWN) } : {}),
    picks, sure: sure.slice(0, SURE_SHOWN),
  };
}

/** Grades a game's first scorer on the real one (SimGrade.first). The chance the sims gave him comes from the shown list;
 *  a scorer off it (a deep bench player, a defensive touchdown) gets 0. */
export function gradeAnswers(a: SimAnswers, g: Pick<SimGrade, "first">, now = new Date()): SimAnswers {
  a.graded_at = now.toISOString();
  if (!g.first) { a.actual = null; return a; }
  const same = (s: Scorer) => s.team === g.first!.team && normName(s.name) === normName(g.first!.name);
  const hit = a.first.find(same);
  a.actual = { ...g.first, chance: hit?.chance ?? 0, top: !!hit && hit === a.first[0] };
  return a;
}

export type FirstRecord = { sport: Sport; games: number; top_hits: number; expected: number; listed: number };
/** How the first-scorer answers did: how often the sims' favorite scored first against how often the sims said he
 *  would (the sum of the favorites' chances), and how often the real scorer was on the shown list. */
export function firstRecord(as: SimAnswers[], sport: Sport): FirstRecord {
  const g = as.filter((a) => a.sport === sport && a.actual);
  return {
    sport, games: g.length, top_hits: g.filter((a) => a.actual!.top).length,
    expected: r1(g.reduce((s, a) => s + (a.first[0]?.chance ?? 0), 0)), listed: g.filter((a) => a.actual!.chance > 0).length,
  };
}
