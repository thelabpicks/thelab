/* NBA hit rates: how often each player cleared a line in his recent games, next to tonight's model chance.
   Two views: DraftKings' posted line (either side), and floor picks, the highest "X+" milestone he almost always reaches. */
import { onDraftKings, overAt, starsOf, surePlay, type NbaRow } from "@/lib/nba";

/** The "X+" milestones DraftKings posts for every player with props (15+ points, 6+ rebounds, ...). */
export const NBA_MILESTONES: Record<string, number[]> = {
  points: [10, 15, 20, 25, 30, 35, 40], rebounds: [4, 6, 8, 10, 12, 14], assists: [2, 4, 6, 8, 10, 12],
  threes: [1, 2, 3, 4, 5, 6], pra: [15, 20, 25, 30, 35, 40, 45, 50],
};
/** A floor pick needs this model chance: tonight's 85%+ calls hit 91% of 225 graded games (Oct 22-29). */
export const FLOOR_MIN_CHANCE = 0.85;

export type HitPick = {
  row: NbaRow; kind: "line" | "floor"; side: "over" | "under"; line: number; milestone: number | null; chance: number;
  /** cleared in his last 5 and last 10 games (games he played) */
  l5: [number, number]; l10: [number, number];
};
export type HitOpts = { threshold: number; window: 5 | 10; side?: "over" | "under"; market?: string; starsOnly?: boolean; search?: string };

const count = (vals: number[], ok: (v: number) => boolean): [number, number] => [vals.filter(ok).length, vals.length];

function pool(rows: NbaRow[], o: HitOpts): NbaRow[] {
  const stars = o.starsOnly ? starsOf(rows) : null;
  // a player DraftKings posts props for tonight, in any market
  const posted = new Set(rows.filter(onDraftKings).map((r) => r.player_id));
  const q = o.search?.trim().toLowerCase();
  return rows.filter((r) => r.dist && surePlay(r) && posted.has(r.player_id) && (!stars || stars.has(r.player_id))
    && (!o.market || r.market === o.market) && (!q || r.player_name.toLowerCase().includes(q)) && r.recent.length >= 5);
}

/** DraftKings' line for each player and market where he went the chosen side in at least `threshold` of his last games. */
export function lineHitRates(rows: NbaRow[], o: HitOpts): HitPick[] {
  const side = o.side ?? "over";
  const out: HitPick[] = [];
  for (const r of pool(rows, o)) {
    if (!onDraftKings(r)) continue;
    const ok = (v: number) => (side === "over" ? v > r.line : v < r.line);
    const l10 = count(r.recent.slice(0, 10), ok), l5 = count(r.recent.slice(0, 5), ok);
    const w = o.window === 5 ? l5 : l10;
    const over = overAt(r, r.line);
    if (over == null || w[0] < o.threshold * w[1] - 1e-9) continue;
    out.push({ row: r, kind: "line", side, line: r.line, milestone: null, chance: side === "over" ? over : 1 - over, l5, l10 });
  }
  return out.sort((a, b) => b.chance - a.chance);
}

/** Per player and market, the highest milestone the model gives 85%+ that he also reached in at least `threshold` of his last games. */
export function floorPicks(rows: NbaRow[], o: HitOpts): HitPick[] {
  const out: HitPick[] = [];
  for (const r of pool(rows, o)) {
    let best: HitPick | null = null;
    for (const x of NBA_MILESTONES[r.market] ?? []) {
      const chance = overAt(r, x - 0.5);
      const ok = (v: number) => v >= x;
      const l10 = count(r.recent.slice(0, 10), ok), l5 = count(r.recent.slice(0, 5), ok);
      const w = o.window === 5 ? l5 : l10;
      if (chance != null && chance >= FLOOR_MIN_CHANCE && w[0] >= o.threshold * w[1] - 1e-9)
        best = { row: r, kind: "floor", side: "over", line: x - 0.5, milestone: x, chance, l5, l10 };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.chance - a.chance);
}
