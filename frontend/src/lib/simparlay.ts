/* The Sim Parlay: a same-game parlay built from a game's 5,000 simulations (scripts/sim-parlays.ts, on every site
   refresh). Each leg is a player reaching a number books post on their alternate ladders (20+ points, 60+ receiving
   yards), set at the highest rung he reaches in at least LEG_MIN of the runs. The parlay's chance is counted straight
   from the runs (the share of runs where every leg hits), so legs that rise and fall together, such as two players
   sharing one offense, are priced as they really move instead of multiplied as if they were independent.

   It posts with the game's sim (posted once on game day, then locked) and is graded on the final box score like the
   sims are, with its own record. Book prices are not bought for it: the price shown is the fair price of the sims'
   chance. */
import type { SimGrade, Sport } from "./simgrades";

/** One run's box score as the engine records it: box[team index][player][engine stat]. */
export type RunBox = Record<string, Record<string, number>>[];
export type LegStat = "pts" | "reb" | "ast" | "tpm" | "pass_yards" | "rush_yards" | "receptions" | "rec_yards";
export type Leg = {
  team: string; name: string; stat: LegStat; min: number; chance: number; median: number;
  actual?: number | null; hit?: boolean | null;
};
export type SimParlay = {
  key: string; sport: Sport; game: string; start: string; built_at: string; runs: number;
  legs: Leg[]; chance: number; fair: number;
  final?: Record<string, number>; hit?: boolean | null; graded_at?: string;
};

/** Rungs books post on their alternate ladders, low to high. */
export const LADDER: Record<LegStat, number[]> = {
  pts: [10, 15, 20, 25, 30, 35, 40], reb: [4, 6, 8, 10, 12, 14], ast: [2, 4, 6, 8, 10, 12], tpm: [1, 2, 3, 4, 5],
  pass_yards: [150, 175, 200, 225, 250, 275, 300], rush_yards: [25, 40, 50, 60, 70, 80, 100],
  receptions: [2, 3, 4, 5, 6, 7, 8], rec_yards: [25, 40, 50, 60, 70, 80, 100],
};
export const LEG_LABEL: Record<LegStat, string> = {
  pts: "points", reb: "rebounds", ast: "assists", tpm: "threes", pass_yards: "passing yards", rush_yards: "rushing yards",
  receptions: "receptions", rec_yards: "receiving yards",
};
/** The engine's box-score names for each stat. */
const BOX: Record<Sport, Partial<Record<LegStat, string>>> = {
  nba: { pts: "pts", reb: "reb", ast: "ast", tpm: "tpm" },
  nfl: { pass_yards: "pyd", rush_yards: "ruyd", receptions: "rec", rec_yards: "ryd" },
};

/** A leg needs this share of the runs on its own, and a rung any surer than LEG_MAX is too low to say anything (a
 *  starter's 10+ points). Backtest on every NBA night of 2026-27 so far (Oct 22-29, the engine run on each night's
 *  frozen projections, 53 games): 4 legs from 75-90% rungs hit 34 of 53 (64%) against 61% in the sims; legs from
 *  80-93% rungs hit 55% against 70%, and 80%+ rungs with no cap (mostly 2+ assists, 10+ points) 74% against 81%. */
export const LEG_MIN = 0.75, LEG_MAX = 0.9;
/** The parlay's legs (it stops adding once the next leg would drop the joint chance under JOINT_MIN). */
export const MAX_LEGS = 4, MIN_LEGS = 3;
export const JOINT_MIN = 0.45;
/** NBA: only players the sims give real minutes, the ones sure to play a full role. */
export const NBA_MIN_MINUTES = 26;

/** A player the sims played: his team index and his key in the engine's box score. */
export type SimPlayer = { ti: number; team: string; name: string; key: string };
type Cand = Leg & { hits: Uint8Array };

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** Every player's best leg in each stat: the highest rung he reaches in LEG_MIN of the runs. */
export function legCandidates(sport: Sport, players: SimPlayer[], boxes: RunBox[], band = [LEG_MIN, LEG_MAX]): Cand[] {
  const out: Cand[] = [];
  for (const p of players) {
    for (const [stat, k] of Object.entries(BOX[sport]) as [LegStat, string][]) {
      const v = boxes.map((b) => b[p.ti][p.key]?.[k] ?? 0);
      let best: Cand | null = null;
      for (const min of LADDER[stat]) {
        const hits = Uint8Array.from(v, (x) => (x >= min ? 1 : 0));
        const chance = hits.reduce((s, h) => s + h, 0) / v.length;
        if (chance < band[0]) break;
        if (chance > band[1]) continue;
        best = { team: p.team, name: p.name, stat, min, chance, median: quantile(v, 0.5), hits };
      }
      if (best) out.push(best);
    }
  }
  return out;
}

/** The parlay: legs added one at a time, each the one that keeps the most runs with every leg hitting, at most two
 *  legs per player. Null when fewer than MIN_LEGS fit. */
export function chooseLegs(cands: Cand[], runs: number, o = { max: MAX_LEGS, min: MIN_LEGS, joint: JOINT_MIN }): { legs: Leg[]; chance: number } | null {
  const legs: Cand[] = [];
  let all = new Uint8Array(runs).fill(1), chance = 1;
  while (legs.length < o.max) {
    let pick: { c: Cand; and: Uint8Array; n: number } | null = null;
    for (const c of cands) {
      if (legs.includes(c) || legs.filter((l) => l.name === c.name && l.team === c.team).length >= 2) continue;
      const and = all.map((a, i) => a & c.hits[i]);
      const n = and.reduce((s, x) => s + x, 0);
      if (!pick || n > pick.n) pick = { c, and, n };
    }
    if (!pick || (legs.length >= o.min && pick.n / runs < o.joint)) break;
    legs.push(pick.c); all = pick.and; chance = pick.n / runs;
  }
  if (legs.length < o.min) return null;
  return { legs: legs.map(({ hits: _, ...l }) => ({ ...l, chance: r3(l.chance) })), chance: r3(chance) };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** American odds of a chance: 0.6 is -150, 0.4 is +150. */
export const fairPrice = (p: number) => (p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));

/** Grades a parlay from its game's sim grade (simgrades.ts: the same ESPN box score, every frozen player's real stats).
 *  A player with no stats at all did not play: his leg is void, as books settle it, and the parlay rides on the rest.
 *  One who played with no line in a stat (no catches) had 0 of it. */
export function gradeParlay(p: SimParlay, g: Pick<SimGrade, "final" | "players">, now = new Date()): SimParlay {
  p.final = g.final;
  for (const l of p.legs) {
    const mine = g.players.filter((x) => x.team === l.team && x.name === l.name);
    l.actual = mine.length ? mine.find((x) => x.stat === l.stat)?.actual ?? 0 : null;
    l.hit = l.actual == null ? null : l.actual >= l.min;
  }
  const live = p.legs.filter((l) => l.hit != null);
  p.hit = live.length ? live.every((l) => l.hit) : null;
  p.graded_at = now.toISOString();
  return p;
}

export type ParlayRecord = { sport: Sport; won: number; lost: number; legs_hit: number; legs: number };
/** Hits and misses of graded parlays (all-void parlays are not counted). */
export function parlayRecord(ps: SimParlay[], sport: Sport): ParlayRecord {
  const g = ps.filter((p) => p.sport === sport && p.hit != null);
  const legs = g.flatMap((p) => p.legs.filter((l) => l.hit != null));
  return { sport, won: g.filter((p) => p.hit).length, lost: g.filter((p) => !p.hit).length, legs_hit: legs.filter((l) => l.hit).length, legs: legs.length };
}
