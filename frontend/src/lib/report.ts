/* The daily model report, posted to Andrew each morning: how the picks and the models did on yesterday's games (every
   lean the model made, not only the picks), where the predictions were off and why (post-game re-runs), and what the
   models changed in themselves (refits, corrections tested and adopted or rejected). Built by scripts/lab-report.ts on
   every site refresh from the files the pages already publish; the 4 am Central refresh is the first one each day.
   Pure: no file access here. */
import { SPORTS, SPORT_LABEL, playDate, tally, type DailyPick, type LabPick, type LabRecord, type LabState, type Sport } from "./lab";
import type { NbaPrevious, NbaRecord, NbaStatus } from "./nba";
import type { CfbPrevious, CfbRecord } from "./cfb";
import type { LiveRecord } from "@/components/LiveRecord";

/** rank: the pick's top 10 rank when it was on the list at kickoff. */
export type ReportPick = Pick<LabPick, "id" | "sport" | "bet" | "matchup" | "kickoff" | "chance" | "result" | "actual" | "rank"> & { potd?: boolean; date: string };
export type SportReport = {
  sport: Sport;
  /** Season to date, and on the results day alone. */
  record: { top10: LabRecord; potd: LabRecord };
  day: { top10: LabRecord; potd: LabRecord };
  results: ReportPick[];
  /** Picks from earlier days graded since the last report. */
  late: ReportPick[];
  pending: ReportPick[];
  /** Picks of the day locked for the report date. */
  today: ReportPick[];
  /** The picks: hits, misses (predicted vs actual), voids. */
  findings: string[];
  /** Every lean the model made on the day's games, graded: how the model did beyond the picks. */
  model: string[];
  /** Where the predictions were off and why (post-game re-runs with what really happened). */
  postgame: string[];
  /** What the models changed in themselves: refits, corrections tested and adopted or rejected. */
  improving: string[];
};
export type DailyReport = {
  /** The morning the report is for (Central time); results are from the day before. */
  date: string; results_date: string; generated_at: string;
  headline: string; sports: SportReport[];
  /** Ids graded as of this report, so the next one can list late grades. */
  graded_ids: string[];
  /** Written by hand (the reports before this ran); refreshes leave it as it is. */
  manual?: boolean;
};

export type ReportInputs = {
  state: LabState;
  nfl?: LiveRecord | null;
  nba?: { record?: NbaRecord | null; status?: NbaStatus | null; previous?: NbaPrevious | null };
  cfb?: { record?: CfbRecord | null; previous?: CfbPrevious | null };
  previous?: DailyReport | null;
};

const DAY_MS = 864e5;
const r1 = (v: number) => Math.round(v * 10) / 10;
const pc = (v: number | null | undefined) => (v == null ? "–" : `${Math.round(v * 100)}%`);
const sgn = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
export const recText = (r: LabRecord) => (r.n ? `${r.won}-${r.lost}${r.push ? `-${r.push}` : ""}` : "0-0");
export const longDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
const shortDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const pickDate = (p: LabPick | DailyPick) => ("date" in p && p.date ? p.date : playDate(p.kickoff));
const potdKey = (p: LabPick) => `${p.game_id}|${p.bet}`;

function toRow(p: LabPick | DailyPick, potd: boolean): ReportPick {
  // a pick of the day keeps the board rank it was chosen with, but only picks frozen on the top 10 count as top 10 picks
  return { id: p.id, sport: p.sport, bet: p.bet, matchup: p.matchup, kickoff: p.kickoff, chance: p.chance, result: p.result, actual: p.actual,
    rank: potd ? undefined : p.rank, potd, date: pickDate(p) };
}

/** Every top 10 pick frozen at kickoff and every pick of the day, one row per bet (a pick of the day that was also on the
 *  top 10 shows once, marked). */
function rowsFor(state: LabState, sport: Sport): ReportPick[] {
  const daily = (state.daily ?? []).filter((d) => d.sport === sport);
  const potd = new Map(daily.map((d) => [potdKey(d), d]));
  const rows = state.frozen.filter((p) => p.sport === sport).map((p) => {
    const d = potd.get(potdKey(p));
    const row = toRow(p, false);
    return d ? { ...row, potd: true, result: d.result ?? p.result, actual: d.actual ?? p.actual } : row;
  });
  const seen = new Set(state.frozen.filter((p) => p.sport === sport).map(potdKey));
  for (const d of daily) if (!seen.has(potdKey(d))) rows.push(toRow(d, true));
  return rows;
}

const withdrawn = (p: ReportPick) => p.result === "void" && (p.actual ?? "").startsWith("Withdrawn");

function findingsFor(sport: Sport, results: ReportPick[]): string[] {
  const out: string[] = [];
  const graded = results.filter((p) => p.result === "won" || p.result === "lost");
  if (graded.length) {
    const hit = graded.filter((p) => p.result === "won");
    const best = hit.sort((a, b) => b.chance - a.chance)[0];
    if (best) out.push(`Surest hit: ${best.bet} (${pc(best.chance)}), ${lcFirst(best.actual ?? "")}.`);
  }
  for (const p of results.filter((x) => x.result === "lost").sort((a, b) => b.chance - a.chance))
    out.push(`Miss: ${p.bet} at ${pc(p.chance)}${p.potd ? " (pick of the day)" : ""}. ${p.actual ?? ""}.`.replace(/\.\.$/, "."));
  const dnp = results.filter((p) => p.result === "void" && !withdrawn(p));
  if (dnp.length) out.push(`${dnp.length === 1 ? "One pick was" : `${dnp.length} picks were`} void because the player did not play (${dnp.map((p) => p.bet.split(" ").slice(0, 2).join(" ")).join(", ")}). Void picks never count.`);
  for (const p of results.filter(withdrawn)) out.push(`Withdrawn before kickoff: ${p.bet}. ${p.actual!.replace(/^Withdrawn before kickoff: (the )?/, "Reason: ")}. Withdrawn picks never count.`);
  const waiting = results.filter((p) => !p.result);
  if (waiting.length) out.push(`${waiting.length} ${waiting.length === 1 ? "pick is" : "picks are"} waiting on a final stat line: ${waiting.map((p) => p.bet).join("; ")}. ${waiting.length === 1 ? "It is" : "They are"} graded on the next refresh after the result posts.`);
  if (!results.length) out.push(`No ${SPORT_LABEL[sport]} picks were played on this day.`);
  return out;
}
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/* ------------------------------------------------------------------ per sport */

type Graded = { chance: number; won: boolean };
/** Hit rate of every graded lean, overall and by how sure the model was. */
function byConfidence(label: string, xs: Graded[]): string | null {
  if (!xs.length) return null;
  const rate = (ys: Graded[]) => (ys.length ? `${pc(ys.filter((y) => y.won).length / ys.length)} of ${ys.length}` : null);
  const bands = [["70%+", 0.7, 2], ["60-70%", 0.6, 0.7], ["under 60%", 0, 0.6]] as const;
  const parts = bands.map(([n, lo, hi]) => { const r = rate(xs.filter((x) => x.chance >= lo && x.chance < hi)); return r ? `${n} hit ${r}` : null; }).filter(Boolean);
  const won = xs.filter((x) => x.won).length;
  return `${label}: ${won}-${xs.length - won} (${pc(won / xs.length)}). By confidence: ${parts.join(", ")}.`;
}

function nbaSections(i: ReportInputs, results_date: string) {
  const model: string[] = [], postgame: string[] = [], improving: string[] = [];
  const st = i.nba?.status, rec = i.nba?.record;
  const day = i.nba?.previous?.days.find((d) => d.date === results_date);
  if (day) {
    const leans = day.games.flatMap((g) => g.picks);
    const line = byConfidence(`Every lean the model made on ${day.games.length} game${day.games.length === 1 ? "" : "s"}`, leans.map((l) => ({ chance: l[6], won: !!l[9] })));
    if (line) model.push(line);
    const unders = leans.filter((l) => l[4] === "under"), overs = leans.filter((l) => l[4] === "over");
    if (unders.length && overs.length) model.push(`Unders ${pc(unders.filter((l) => l[9]).length / unders.length)} (${unders.length}), overs ${pc(overs.filter((l) => l[9]).length / overs.length)} (${overs.length}).`);
    const worst = leans.filter((l) => !l[9] && l[6] >= 0.75 && l[7] != null).sort((a, b) => Math.abs(b[8] - b[7]!) - Math.abs(a[8] - a[7]!)).slice(0, 3);
    if (worst.length) model.push(`Furthest off among confident leans: ${worst.map((l) => `${l[1]} ${l[3]} (projected ${r1(l[7]!)}, had ${l[8]}, line ${l[5]})`).join("; ")}.`);
  }
  const pg = rec?.post_game;
  if (pg?.n) {
    if (pg.lost) postgame.push(`Re-run with the minutes players really got, ${pg.lost_minutes_explain} of ${pg.lost} losing leans would have been right, so minutes caused ${pc((pg.lost_minutes_explain ?? 0) / pg.lost)} of the misses and production the rest (last 2 weeks).`);
    if (pg.minutes) postgame.push(`Minutes ran ${sgn(pg.minutes.bias)} per player vs the projection (typical miss ${pg.minutes.avg_miss}).`);
    if (pg.team_rotation) postgame.push(`Team scoring: rotations scored ${sgn(pg.team_rotation.bias)} points per team vs projected (typical miss ${pg.team_rotation.avg_miss}).`);
  }
  const limit: Record<string, number> = { points: 1, pra: 1.5, rebounds: 0.5, assists: 0.5, threes: 0.3 };
  for (const m of rec?.projection_check ?? [])
    if (m.last7_n >= 30 && Math.abs(m.last7_bias) >= (limit[m.market] ?? 1))
      postgame.push(`${m.label} has run ${m.last7_bias > 0 ? "above" : "below"} the projections for 7 days (${sgn(m.last7_bias, 2)} per player). If it holds, that's a skewed input to correct.`);
  if (st?.validated_markets?.length) improving.push(`Refit this morning on every box score through ${st.history.last_game_date}; ${st.validated_markets.length} of 5 markets passed the test on unseen games (${st.validated_markets.join(", ")}).`);
  const tc = st?.team_check;
  if (tc?.plain && tc.adjusted) improving.push(`Team scoring correction ${tc.use ? "kept" : "turned off"}: 65%+ leans hit ${pc(tc.adjusted.strong_hit)} with it vs ${pc(tc.plain.strong_hit)} without on unseen seasons.`);
  return { model, postgame, improving };
}

function nflSections(i: ReportInputs, results_date: string) {
  const model: string[] = [], postgame: string[] = [], improving: string[] = [];
  const live = i.nfl;
  const games = (live?.previous_weeks ?? []).flatMap((w) => w.games).filter((g) => g.kickoff && playDate(g.kickoff) === results_date);
  const leans = games.flatMap((g) => g.picks).filter((p) => p[9] != null);
  const line = byConfidence(`Every graded prop and TD lean on ${games.length} game${games.length === 1 ? "" : "s"}`, leans.map((p) => ({ chance: p[6], won: p[9] === 1 })));
  if (line) model.push(line);
  if (live?.featured?.n) model.push(`Featured picks this season: ${live.featured.hits} of ${live.featured.n} (${pc(live.featured.rate)}).`);
  for (const d of live?.drift ?? []) model.push(`Off calibration: ${d}.`);
  const sr = live?.sim_report;
  if (sr?.available && games.length) {
    postgame.push(...(sr.notes ?? []));
    const m = sr.biggest_misses?.slice(0, 3) ?? [];
    if (m.length) postgame.push(`Biggest misses: ${m.map((x) => `${x.player} ${x.market.replace(/_/g, " ")} (sim ${r1(x.pre)}, had ${x.actual}; ${x.cause})`).join("; ")}.`);
  }
  const names: Record<string, string> = { catch_adj: "catch rate", ypt_adj: "yards per target", ypc_adj: "yards per carry" };
  const t = Object.entries(sr?.corrections?.tests ?? {});
  const adopted = t.filter(([, v]) => v.adopt).map(([k]) => names[k] ?? k);
  const rejected = t.filter(([, v]) => !v.adopt).map(([k, v]) => `${names[k] ?? k} (${sgn(v.gain, 4)})`);
  if (adopted.length) improving.push(`Adopted: ${adopted.join(", ")} correction${adopted.length === 1 ? "" : "s"}, which tested better on recent weeks.`);
  if (rejected.length) improving.push(`Tested and rejected (no reliable gain on recent weeks): ${rejected.join(", ")}.`);
  const use = sr?.corrections?.in_use ?? {};
  if (use.pass_adj != null || use.rush_adj != null) improving.push(`Team volume learned from the re-sims: passes x${use.pass_adj ?? 1}, runs x${use.rush_adj ?? 1}.`);
  return { model, postgame, improving };
}

function cfbSections(i: ReportInputs, results_date: string) {
  const model: string[] = [], postgame: string[] = [], improving: string[] = [];
  const rec = i.cfb?.record;
  const games = (i.cfb?.previous?.games ?? []).filter((g) => g.date.slice(0, 10) === results_date || playDate(g.date) === results_date);
  const NAMES: Record<string, string> = { spread: "Spreads", total: "Totals", moneyline: "Winners", team_total: "Team totals" };
  for (const mk of ["moneyline", "spread", "total"]) {
    const xs = games.flatMap((g) => g.markets).filter((m) => m.market === mk && m.result !== "push").map((m) => ({ chance: m.p, won: m.result === "won" }));
    const l = byConfidence(`${NAMES[mk]} (${games.length} game${games.length === 1 ? "" : "s"})`, xs);
    if (l) model.push(l);
  }
  const off = games.filter((g) => g.model && g.line.total != null)
    .map((g) => ({ g, miss: g.score[0] + g.score[1] - (g.model!.home + g.model!.away) })).sort((a, b) => Math.abs(b.miss) - Math.abs(a.miss)).slice(0, 2);
  if (off.length) model.push(`Furthest off: ${off.map(({ g, miss }) => `${g.away} at ${g.home} (projected ${r1(g.model!.home + g.model!.away)} total, scored ${g.score[0] + g.score[1]}, ${sgn(miss)})`).join("; ")}.`);
  if (rec?.suggested?.n) model.push(`Suggested college bets this season: ${rec.suggested.hits}-${rec.suggested.n - rec.suggested.hits} (${pc(rec.suggested.rate)}).`);
  const card = rec?.report_card;
  if (card?.resim?.games) postgame.push(`Re-run with the real plays, yards per play and turnovers, the total's typical miss falls from ${r1(card.resim.total_input_miss + card.resim.total_rest_miss)} to ${r1(card.resim.total_rest_miss)} points (${card.resim.games} games), so most of the miss was the inputs, not chance.`);
  for (const x of (card?.inputs ?? []).filter((x) => x.n >= 20).slice(0, 3)) postgame.push(`${x.input} ran ${sgn(x.bias, 2)} vs the pregame input (typical miss ${r1(x.mae)}).`);
  if (card?.total?.line_mae != null) improving.push(`Totals: typical miss ${r1(card.total.model_mae)} points vs ${r1(card.total.line_mae)} for the closing line. Ratings refit every morning on the newest finals; new inputs ship only after testing better in the Monday review.`);
  return { model, postgame, improving };
}

/* ------------------------------------------------------------------ the report */

/** The report for the morning of `date` (Central), covering the games of the day before. */
export function buildReport(i: ReportInputs, now: Date): DailyReport {
  const date = playDate(now);
  const results_date = playDate(new Date(now.getTime() - DAY_MS));
  const prevGraded = new Set(i.previous?.graded_ids ?? []);
  const sports: SportReport[] = SPORTS.map((sport) => {
    const rows = rowsFor(i.state, sport);
    const graded = rows.filter((p) => p.result);
    const top = (xs: ReportPick[]) => xs.filter((p) => p.rank != null);
    const pot = (xs: ReportPick[]) => xs.filter((p) => p.potd);
    const results = rows.filter((p) => p.date === results_date && new Date(p.kickoff) <= now).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    const late = i.previous ? graded.filter((p) => p.date < results_date && !prevGraded.has(p.id)) : [];
    const pending = rows.filter((p) => !p.result && p.date <= results_date);
    const today = (i.state.daily ?? []).filter((d) => d.sport === sport && d.date === date && !d.withdrawn).map((d) => toRow(d, true));
    const asLab = (xs: ReportPick[]) => xs as unknown as LabPick[];
    const sec = sport === "nba" ? nbaSections(i, results_date) : sport === "nfl" ? nflSections(i, results_date) : cfbSections(i, results_date);
    const findings = findingsFor(sport, results);
    if (late.length) findings.push(`Graded since the last report: ${late.map((p) => `${p.bet} ${p.result === "won" ? "✓" : p.result === "lost" ? "✗" : "(void)"}`).join("; ")}.`);
    return {
      sport,
      record: { top10: tally(asLab(top(graded))), potd: tally(asLab(pot(graded))) },
      day: { top10: tally(asLab(top(results))), potd: tally(asLab(pot(results))) },
      results, late, pending, today, findings, ...sec,
    };
  });
  const played = sports.filter((s) => s.results.length);
  const headline = played.length
    ? `${shortDay(results_date)}: ` + played.map((s) => {
        const all = tally(s.results as unknown as LabPick[]);
        const waiting = s.results.filter((p) => !p.result).length;
        const bits = [all.n ? recText(all) : "", waiting ? `${waiting} pending` : "", !all.n && !waiting ? `${all.void} void` : ""].filter(Boolean);
        return `${SPORT_LABEL[s.sport]} ${bits.join(" with ")}`;
      }).join(", ") + "."
    : `${shortDay(results_date)}: no picks were played.`;
  return {
    date, results_date, generated_at: now.toISOString(), headline, sports,
    graded_ids: sports.flatMap((s) => rowsFor(i.state, s.sport).filter((p) => p.result).map((p) => p.id)),
  };
}

/** The report as plain text, for posting or a message. */
export function reportText(r: DailyReport): string {
  const lines = [`The Lab daily report, ${longDay(r.date)} (results from ${longDay(r.results_date)})`, ""];
  lines.push("Records (top 10 / picks of the day, season):");
  for (const s of r.sports) lines.push(`  ${SPORT_LABEL[s.sport]}: ${recText(s.record.top10)} / ${recText(s.record.potd)}`);
  for (const s of r.sports) {
    lines.push("", `${SPORT_LABEL[s.sport]}`);
    const part = (title: string, xs: string[]) => { if (xs.length) lines.push(`  ${title}`, ...xs.map((x) => `    - ${x}`)); };
    part("Picks", s.findings);
    part("How the model did", s.model);
    part("Where it was off and why", s.postgame);
    part("Model changes", s.improving);
  }
  return lines.join("\n");
}
