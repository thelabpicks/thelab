/* Builds The Lab's picks from the published site data (run by the "Refresh data and publish site" workflow after every
   sport's numbers are in place):

     LAB_DATA=../site-data LAB_ARCHIVE=../pick-archive/lab npx vite-node scripts/lab-picks.ts

   Reads each sport's published files exactly as the pages do, ranks the proven picks across sports, freezes the picks
   whose games have started, grades frozen picks from each sport's own graded results, and writes
   LAB_DATA/lab/board.json for the page and LAB_ARCHIVE/state.json (kept on the nfl-data branch between runs).
   A sport whose files are missing is left out for this run; nothing here stops the site from publishing. */
import fs from "node:fs";
import path from "node:path";
import { staticKey, type Params } from "../src/lib/static";
import type { AskData, AskDefenses, PropRow } from "../src/lib/ask";
import type { Feed, OddsResp } from "../src/lib/feed";
import type { Confidence } from "../src/lib/confidence";
import type { RankingsResponse } from "../src/lib/types";
import { dueRecord, type DueStudy } from "../src/lib/signals";
import type { NbaConfidence, NbaDue, NbaRecord, NbaStatus, MarketReport, Slate } from "../src/lib/nba";
import type { Backtest, CfbRecord, Props as CfbProps, Teams, Week } from "../src/lib/cfb";
import { advance, cfbCandidates, nbaCandidates, nflCandidates, publish, type LabPick, type LabState, type NbaGraded, type NflSettled, type Results, type Sport } from "../src/lib/lab";

const DATA = path.resolve(process.env.LAB_DATA || "../site-data");
const ARCHIVE = path.resolve(process.env.LAB_ARCHIVE || "../data/lab");

function read<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8")) as T; } catch { return null; }
}
const nflFile = <T>(p: string, params: Params = {}) => read<T>(staticKey(p, params));

/** The same inputs the NFL Ask page loads (pages/Ask.tsx useAskData), from the exported files. */
function nflData(): AskData | null {
  const weeks = nflFile<{ current_season: number; current_week: number }>("/weeks");
  if (!weeks) return null;
  const sw = { season: weeks.current_season, week: weeks.current_week };
  const ranks = nflFile<RankingsResponse>("/rankings", sw);
  if (!ranks) return null;
  const markets = nflFile<{ markets: { market: string; label: string; validated: boolean }[] }>("/props/markets")?.markets ?? [];
  const props: AskData["props"] = {};
  for (const m of markets.filter((x) => x.validated)) {
    const rows = nflFile<{ rows: PropRow[] }>("/props", { ...sw, market: m.market })?.rows;
    if (rows) props[m.market] = { label: m.label, rows };
  }
  const odds = nflFile<OddsResp>("/odds", sw);
  const idx = new Map<string, OddsResp["rows"]>();
  for (const r of odds?.rows ?? []) { const k = `${r.market}:${r.player_id}:${r.side}`; idx.set(k, [...(idx.get(k) ?? []), r]); }
  const feed: Feed = { at: odds?.fetched_at ?? null, get: (m, p, s) => idx.get(`${m}:${p}:${s}`) ?? [] };
  const model = nflFile<{ use_correlation: boolean; buckets: AskData["buckets"] }>("/parlay/model");
  const d: AskData = {
    ...sw, td: ranks.calibrated ? ranks.rows.filter((r) => r.eligible).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)) : [], props, feed,
    conf: nflFile<Confidence>("/backtest/confidence") ?? undefined, buckets: model?.buckets ?? {}, useCorr: !!model?.use_correlation,
    dueRecord: dueRecord(nflFile<DueStudy>("/backtest/due") ?? undefined), defenses: nflFile<AskDefenses>("/defenses", sw),
  };
  return d;
}

const sports: Record<Sport, { loaded: boolean; candidates: number }> = { nfl: { loaded: false, candidates: 0 }, nba: { loaded: false, candidates: 0 }, cfb: { loaded: false, candidates: 0 } };
const cands: LabPick[] = [];
const res: Results = {};
const tryRun = (sport: Sport, f: () => LabPick[] | null) => {
  try {
    const c = f();
    if (c) { sports[sport] = { loaded: true, candidates: c.length }; cands.push(...c); }
  } catch (e) { console.warn(`lab: ${sport} left out this run (${(e as Error).message})`); }
};

tryRun("nfl", () => {
  // results are graded even between weeks, when the new week has no rankings yet (Tuesday until rosters post)
  res.nfl = nflFile<{ recent_rows?: NflSettled[] }>("/backtest/live")?.recent_rows ?? [];
  const d = nflData();
  return d ? nflCandidates(d) : null;
});
tryRun("nba", () => {
  const slate = read<Slate>("nba/slate.json");
  const record = read<NbaRecord & { graded?: NbaGraded[] }>("nba/record.json");
  if (record?.graded) res.nba = { rows: record.graded, through: record.graded.map((r) => r.date).sort().at(-1) ?? null };
  if (!slate) return null;
  return nbaCandidates(slate, { conf: read<NbaConfidence>("nba/confidence.json") ?? undefined, markets: read<{ markets: MarketReport[] }>("nba/markets.json") ?? undefined,
    record: record ?? undefined, due: read<NbaDue>("nba/due.json") ?? undefined, status: read<NbaStatus>("nba/status.json") ?? undefined });
});
tryRun("cfb", () => {
  const rec = read<CfbRecord & { finals?: Record<string, [number, number]> }>("cfb/record.json");
  if (rec?.finals) res.cfb = rec.finals;
  const week = read<Week>("cfb/week.json");
  if (!week) return null;
  return cfbCandidates(week, { teams: read<Teams>("cfb/teams.json")?.teams, bt: read<Backtest>("cfb/backtest.json") ?? undefined, props: read<CfbProps>("cfb/props.json")?.rows });
});

const stateFile = path.join(ARCHIVE, "state.json");
let prev: LabState = { updated_at: null, board: [], frozen: [] };
try { prev = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* first run */ }
const next = advance(prev, cands, res, new Date());
fs.mkdirSync(ARCHIVE, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(next));
fs.mkdirSync(path.join(DATA, "lab"), { recursive: true });
fs.writeFileSync(path.join(DATA, "lab", "board.json"), JSON.stringify(publish(next, sports)));
console.log(`lab: ${next.board.length} picks on the board (${Object.entries(sports).map(([s, v]) => `${s} ${v.loaded ? v.candidates : "not loaded"}`).join(", ")}), `
  + `${next.frozen.length} frozen, ${next.frozen.filter((p) => p.result).length} graded`);
