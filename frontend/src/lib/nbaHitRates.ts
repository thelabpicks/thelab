/* NBA hit rates: how often each player cleared a line in his recent games, next to tonight's model chance.
   Two views: DraftKings' posted line (either side), and floor picks, the highest "X+" milestone he almost always reaches. */
import { onDraftKings, overAt, starsOf, surePlay, type NbaRow } from "@/lib/nba";

/** Floor picks need this model chance: tonight's 80-85% calls have hit 83% of graded games, 85%+ calls 91%. */
export const FLOOR_MIN_CHANCE = 0.8;
/** A rung priced shorter than this is not worth betting (12+ points at -1200): realistic odds only. */
export const FLOOR_SHORTEST_PRICE = -700;
/** Largest gap allowed between the model's chance and the price's: beyond it the data, not the bet, is suspect. */
export const FLOOR_MAX_GAP = 0.15;

export type HitPick = {
  row: NbaRow; kind: "line" | "floor"; side: "over" | "under"; line: number; milestone: number | null; chance: number;
  /** DraftKings' American price for a floor pick's rung */
  price: number | null;
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
    out.push({ row: r, kind: "line", side, line: r.line, milestone: null, chance: side === "over" ? over : 1 - over, price: null, l5, l10 });
  }
  return out.sort((a, b) => b.chance - a.chance);
}

/** Per player and market, the highest rung of DraftKings' "X+" ladder priced -700 or longer that the model gives 80%+ and
 *  that he reached in at least `threshold` of his last games. Only rungs DraftKings actually posts. */
export function floorPicks(rows: NbaRow[], o: HitOpts): HitPick[] {
  const out: HitPick[] = [];
  for (const r of pool(rows, o)) {
    let best: HitPick | null = null;
    for (const [x, price] of r.milestones ?? []) {
      if (price < FLOOR_SHORTEST_PRICE) continue;
      const chance = overAt(r, x - 0.5);
      // the model and DraftKings this far apart means the rung is misread (a quarter ladder as the full game), not an edge
      if (chance == null || Math.abs(chance - implied(price)) > FLOOR_MAX_GAP) continue;
      const ok = (v: number) => v >= x;
      const l10 = count(r.recent.slice(0, 10), ok), l5 = count(r.recent.slice(0, 5), ok);
      const w = o.window === 5 ? l5 : l10;
      if (chance != null && chance >= FLOOR_MIN_CHANCE && w[0] >= o.threshold * w[1] - 1e-9 && (!best || x > best.milestone!))
        best = { row: r, kind: "floor", side: "over", line: x - 0.5, milestone: x, chance, price, l5, l10 };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.chance - a.chance);
}

/** The chance a price implies (-446 is 82%). */
export const implied = (american: number) => (american < 0 ? -american / (100 - american) : 100 / (american + 100));
