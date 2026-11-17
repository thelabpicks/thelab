/* Confidence tiers: plain-language bands with how often past walk-forward picks in each band actually hit. */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type Tier = { tier: string; lo: number; hi: number; n: number; hits: number; rate: number | null; avg_chance: number | null; ci: [number | null, number | null] };
/** One band of the measured confidence table (backend engine/measured.py): graded leans at book lines the model rated
 *  lo to hi, and how many hit. */
export type Band = { lo: number; hi: number; n: number; hits: number; rate: number | null };
export type BookCal = { kind: "measured"; bands: Band[]; shrink: number; rows: number; periods: number; test_periods: number;
  log_loss_raw: number; log_loss_table: number };
/** The chance of the over at a book line, shown as the measured record of leans that confident at book lines: the
 *  band's hit rate, nudged toward the model's own chance only as much as the band's sample is small, never below 50%. */
export const bookCal = (pOver: number, c: BookCal | null | undefined) => {
  if (!c?.bands?.length) return pOver;
  const lean = Math.max(pOver, 1 - pOver);
  const b = c.bands.find((x, i) => lean >= x.lo && (lean < x.hi || i === c.bands.length - 1)) ?? c.bands[c.bands.length - 1];
  const shown = Math.max(0.5, (b.hits + c.shrink * lean) / (b.n + c.shrink));
  return pOver >= 0.5 ? shown : 1 - shown;
};

export type Confidence = {
  td: { model: string; weeks: number; first_season: number; tiers: Tier[] } | null;
  props: { weeks: number; first_season: number; tiers: Tier[]; note: string; by_side?: { over: Tier[]; under: Tier[] };
    line_history?: Record<string, { lo: number; hi: number; n: number; avg_line: number; avg_actual: number; over_rate: number; avg_p_over: number }[]>;
    unders_by_market?: { market: string; label: string; n: number; hits: number; rate: number; avg_chance: number; strong_n: number; strong_rate: number | null }[];
    /** The measured confidence table at book lines (engine/picklog.py); null until it beats the raw chances on unseen weeks. */
    book_calibration?: BookCal | null } | null;
};

export function useConfidence() {
  return useQuery({ queryKey: ["confidence"], queryFn: () => api.get<Confidence>("/backtest/confidence"), staleTime: 5 * 60_000 });
}

/** The tier a chance falls in. Props use the chance of the side picked (always ≥ 50%). */
export function tierFor(c: Confidence | undefined, kind: "td" | "props", p: number | null | undefined): Tier | null {
  if (p == null || !c) return null;
  const t = kind === "td" ? c.td : c.props;
  return t?.tiers.find((x) => p >= x.lo && p < (x.hi >= 1 ? 1.01 : x.hi)) ?? null;
}

export const tierTone = (name?: string) => (name === "Strong" ? "ok" : name === "Solid" ? "accent" : name === "Lean" ? "neutral" : "warn") as
  "ok" | "accent" | "neutral" | "warn";

/** Picks we suggest: only tiers whose past picks hit at least half the time on weeks the model never saw.
 *  "Coin flip" hovers right at 50%, so it never counts. Without tier data, fall back to the chance itself. */
export const PROVEN_MIN = 0.5;
export function proven(c: Confidence | undefined, kind: "td" | "props", p: number | null | undefined): boolean {
  if (p == null) return false;
  if (!c) return p >= PROVEN_MIN;
  const t = tierFor(c, kind, p);
  return !!t && t.tier !== "Coin flip" && t.rate != null && t.rate >= PROVEN_MIN;
}
export const PROVEN_NOTE = "Only picks from confidence tiers that hit 50%+ on unseen weeks (walk-forward backtest) are suggested.";
