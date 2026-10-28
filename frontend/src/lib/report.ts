/* The daily model report: what the models said, how it went, what was cross-checked before the games, what the
   post-game reviews found, and what changed in the models. Built by scripts/lab-report.ts on every site refresh from
   the files the pages already publish; the 4 am Central refresh is the first one each day. Pure: no file access here. */
import { SPORTS, SPORT_LABEL, playDate, tally, type DailyPick, type LabPick, type LabRecord, type LabState, type Sport } from "./lab";
import type { NbaRecord, NbaStatus } from "./nba";
import type { CfbRecord } from "./cfb";
import type { LiveRecord } from "@/components/LiveRecord";

/** rank: the pick's top 10 rank when it was on the list at kickoff. */
export type ReportPick = Pick<LabPick, "id" | "sport" | "bet" | "matchup" | "kickoff" | "chance" | "result" | "actual" | "rank"> & { potd?: boolean; date: string };
/** ok: true checked out, false needs a look, null for information. */
export type Check = { ok: boolean | null; text: string };
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
  findings: string[];
  checks: Check[];
  postgame: string[];
  improving: string[];
};
export type Change = { title: string; url: string; at: string };
export type DailyReport = {
  /** The morning the report is for (Central time); results are from the day before. */
  date: string; results_date: string; generated_at: string;
  headline: string; sports: SportReport[]; changes: Change[];
  /** Ids graded as of this report, so the next one can list late grades. */
  graded_ids: string[];
  /** Written by hand (the reports before this ran); refreshes leave it as it is. */
  manual?: boolean;
};
export type ReportIndex = { latest: string | null; reports: { date: string; results_date: string; headline: string }[] };

export type ReportInputs = {
  state: LabState;
  nfl?: LiveRecord | null;
  nba?: { record?: NbaRecord | null; status?: NbaStatus | null; collect?: CollectStatus | null };
  cfb?: { record?: CfbRecord | null; collect?: CollectStatus | null };
  changes?: Change[];
  previous?: DailyReport | null;
};
/** The collect workflows' own status files (nba-data / cfb-data branches). */
export type CollectStatus = {
  date?: string; box_scores?: { last_game_date?: string | null };
  espn?: { injuries?: { items?: number }; scoreboard?: { items?: number } };
  official_injuries?: { players?: number; error?: string; skipped?: string; report?: string };
  odds?: { credits_remaining?: number | null; game_lines?: number; props?: number };
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

function nbaSections(i: ReportInputs, results_date: string, pendingN: number) {
  const checks: Check[] = [], postgame: string[] = [], improving: string[] = [];
  const st = i.nba?.status, rec = i.nba?.record, col = i.nba?.collect;
  const through = col?.box_scores?.last_game_date ?? st?.history.last_game_date ?? null;
  if (through) {
    checks.push(through >= results_date
      ? { ok: true, text: `Box scores are in through ${shortDay(through)}, so every finished game is graded.` }
      : { ok: false, text: `Box scores were only posted through ${shortDay(through)} at refresh time${pendingN ? `; ${pendingN} pick${pendingN === 1 ? "" : "s"} from ${shortDay(results_date)} will be graded on the next refresh` : ""}. The free box-score feed usually catches up by midday.` });
  }
  const oi = col?.official_injuries;
  if (oi) {
    checks.push(oi.players != null ? { ok: true, text: `Official NBA injury report read: ${oi.players} players listed (${oi.report ?? "latest report"}).` }
      : oi.skipped ? { ok: null, text: `Official NBA injury report: ${oi.skipped}; the ESPN injury list was used.` }
      : { ok: false, text: `The official NBA injury report could not be read (${oi.error ?? "unknown"}); the ESPN injury list (${col?.espn?.injuries?.items ?? "?"} teams) was used instead.` });
  }
  if (st?.injuries_as_of) checks.push({ ok: null, text: `Injury list as of ${new Date(st.injuries_as_of).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} Central; ${st.slate_games} games and ${st.projected_players} players projected for ${st.slate_date ? shortDay(st.slate_date) : "the next slate"}.` });
  if (col?.odds) checks.push({ ok: (col.odds.props ?? 0) > 0 ? true : null, text: (col.odds.props ?? 0) > 0 ? `${col.odds.props} posted prop prices saved.` : "No posted NBA prop lines on the free odds plan, so picks use DraftKings-posted stars or the player's usual line." });
  const pg = rec?.post_game;
  if (pg?.n) {
    if (pg.minutes) postgame.push(`Minutes: players averaged ${sgn(pg.minutes.bias)} minutes vs the projection (typical miss ${pg.minutes.avg_miss}) over ${pg.minutes.players} player-games.`);
    if (pg.lost) postgame.push(`Re-run with the minutes they really played, ${pg.lost_minutes_explain} of ${pg.lost} losing leans would have been right: minutes, not production, drove ${pc((pg.lost_minutes_explain ?? 0) / pg.lost)} of the misses.`);
    if (pg.team_rotation) postgame.push(`Team scoring: projected rotations ran ${sgn(-pg.team_rotation.bias)} points per team vs what they scored (typical miss ${pg.team_rotation.avg_miss}, ${pg.team_rotation.games} games).`);
    if (pg.injury_listed?.n) postgame.push(`Injury-listed players: ${pg.injury_listed.n} leans hit ${pc(pg.injury_listed.hit)}, minutes ${sgn(pg.injury_listed.minutes_bias ?? 0)} vs projection.`);
  }
  const limit: Record<string, number> = { points: 1, pra: 1.5, rebounds: 0.5, assists: 0.5, threes: 0.3 };
  for (const m of rec?.projection_check ?? [])
    if (m.last7_n >= 30 && Math.abs(m.last7_bias) >= (limit[m.market] ?? 1))
      postgame.push(`${m.label} ran ${m.last7_bias > 0 ? "above" : "below"} the projections over the last 7 days (${sgn(m.last7_bias, 2)} per player, ${m.last7_n} players). Watching it; the models refit on these games every day.`);
  const strong = rec?.tiers?.find((t) => t.tier === "Strong");
  if (strong?.n) postgame.push(`Live leans at 65%+ have hit ${pc(strong.rate)} (${strong.hits} of ${strong.n}) since the record started.`);
  if (st?.validated_markets?.length) improving.push(`Every NBA model refit on the newest box scores this morning; ${st.validated_markets.length} markets passed the walk-forward gate (${st.validated_markets.join(", ")}).`);
  const tc = st?.team_check;
  if (tc?.plain && tc.adjusted) improving.push(`Team scoring check ${tc.use ? "stays on" : "is off"}: tested on unseen seasons, 65%+ leans hit ${pc(tc.adjusted.strong_hit)} with it vs ${pc(tc.plain.strong_hit)} without.`);
  return { checks, postgame, improving };
}

function nflSections(i: ReportInputs) {
  const checks: Check[] = [], postgame: string[] = [], improving: string[] = [];
  const live = i.nfl;
  const sr = live?.sim_report;
  const wk = live?.weeks?.at(-1);
  if (wk) checks.push(wk.pending ? { ok: null, text: `Week ${wk.week}: ${wk.picks} picks saved, ${wk.pending} waiting on games or box scores.` }
    : { ok: true, text: `Week ${wk.week}: all ${wk.graded} picks graded (${wk.void} void).` });
  if (sr?.available && sr.pending) checks.push({ ok: null, text: `${sr.pending} frozen game simulations are waiting on box scores before their post-game re-run.` });
  if (sr?.available) {
    postgame.push(`Post-game re-sims: ${sr.games} games re-run with what really happened (Week ${sr.last_week?.week} latest).`);
    postgame.push(...(sr.notes ?? []));
    const m = sr.biggest_misses?.slice(0, 3) ?? [];
    if (m.length) postgame.push(`Biggest misses: ${m.map((x) => `${x.player} ${x.market.replace(/_/g, " ")} (sim ${r1(x.pre)}, actual ${x.actual}, ${x.cause})`).join("; ")}.`);
  }
  for (const d of live?.drift ?? []) postgame.push(`Drift flag: ${d}.`);
  if (live?.featured?.n) postgame.push(`Featured picks have hit ${pc(live.featured.rate)} (${live.featured.hits} of ${live.featured.n}) since picks were first frozen.`);
  const tests = sr?.corrections?.tests ?? {};
  const names: Record<string, string> = { catch_adj: "catch rate", ypt_adj: "yards per target", ypc_adj: "yards per carry" };
  const t = Object.entries(tests);
  if (t.length) {
    const adopted = t.filter(([, v]) => v.adopt).map(([k]) => names[k] ?? k);
    const rejected = t.filter(([, v]) => !v.adopt).map(([k, v]) => `${names[k] ?? k} (${sgn(v.gain, 4)})`);
    if (adopted.length) improving.push(`Adopted after testing on recent weeks: ${adopted.join(", ")} corrections.`);
    if (rejected.length) improving.push(`Tested and not adopted (no reliable gain on recent weeks): ${rejected.join(", ")}.`);
  }
  const use = sr?.corrections?.in_use ?? {};
  if (use.pass_adj != null || use.rush_adj != null) improving.push(`Team volume in this week's sims: passes x${use.pass_adj ?? 1}, runs x${use.rush_adj ?? 1}, learned from the post-game reviews.`);
  improving.push("NFL models refit on every new box score at each refresh; simulation blend weights are retested each run.");
  return { checks, postgame, improving };
}

function cfbSections(i: ReportInputs, pending: ReportPick[], now: Date) {
  const checks: Check[] = [], postgame: string[] = [], improving: string[] = [];
  const rec = i.cfb?.record, col = i.cfb?.collect;
  const late = pending.filter((p) => now.getTime() - new Date(p.kickoff).getTime() > 6 * 3600e3);
  if (late.length) checks.push({ ok: false, text: `${late.length} finished game${late.length === 1 ? " is" : "s are"} still waiting on a final score (the college score feed runs about a day behind for late games): ${late.map((p) => p.matchup).join(", ")}.` });
  if (col?.odds) checks.push({ ok: (col.odds.game_lines ?? 0) > 0, text: `${col.odds.game_lines ?? 0} college game-line prices saved on the last collect${col.odds.credits_remaining != null ? `; ${col.odds.credits_remaining} odds credits left this month` : ""}.` });
  if (rec?.suggested?.n) postgame.push(`Suggested college bets (proven tiers) are ${rec.suggested.hits}-${rec.suggested.n - rec.suggested.hits} (${pc(rec.suggested.rate)}) live.`);
  const card = rec?.report_card;
  if (card?.total?.line_mae != null) postgame.push(`Totals: the model's typical miss was ${r1(card.total.model_mae)} points vs ${r1(card.total.line_mae)} for the closing line over ${card.games} games.`);
  if (card?.resim?.games) postgame.push(`Post-game re-sims (${card.resim.games} games): with the real plays, yards per play and turnovers, the total's miss falls from ${r1(card.resim.total_input_miss + card.resim.total_rest_miss)} to ${r1(card.resim.total_rest_miss)}.`);
  for (const x of (card?.inputs ?? []).filter((x) => x.n >= 20).slice(0, 3)) postgame.push(`${x.input}: ran ${sgn(x.bias, 2)} vs the pregame input (typical miss ${r1(x.mae)}, ${x.n} team-games).`);
  improving.push("College ratings and totals refit every morning on the newest finals; candidate inputs are tested walk-forward in the Monday review and shipped only when they test better.");
  return { checks, postgame, improving };
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
    const sec = sport === "nba" ? nbaSections(i, results_date, pending.filter((p) => p.date === results_date).length)
      : sport === "nfl" ? nflSections(i) : cfbSections(i, pending, now);
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
    date, results_date, generated_at: now.toISOString(), headline, sports, changes: i.changes ?? [],
    graded_ids: sports.flatMap((s) => rowsFor(i.state, s.sport).filter((p) => p.result).map((p) => p.id)),
  };
}

export function addToIndex(idx: ReportIndex, r: DailyReport, keep = 60): ReportIndex {
  const reports = [{ date: r.date, results_date: r.results_date, headline: r.headline }, ...idx.reports.filter((x) => x.date !== r.date)]
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, keep);
  return { latest: reports[0]?.date ?? null, reports };
}

/** The report as plain text, for posting or a message. */
export function reportText(r: DailyReport, siteUrl?: string): string {
  const lines = [`The Lab daily report, ${longDay(r.date)} (results from ${longDay(r.results_date)})`, ""];
  lines.push("Records (top 10 / picks of the day, season):");
  for (const s of r.sports) lines.push(`  ${SPORT_LABEL[s.sport]}: ${recText(s.record.top10)} / ${recText(s.record.potd)}`);
  for (const s of r.sports) {
    lines.push("", `${SPORT_LABEL[s.sport]}`);
    for (const f of s.findings) lines.push(`  - ${f}`);
    for (const c of s.checks) lines.push(`  ${c.ok === false ? "!" : "-"} ${c.text}`);
    for (const p of s.postgame) lines.push(`  - ${p}`);
    for (const p of s.improving) lines.push(`  - ${p}`);
  }
  if (r.changes.length) lines.push("", "Shipped:", ...r.changes.map((c) => `  - ${c.title}`));
  if (siteUrl) lines.push("", `${siteUrl}report?date=${r.date}`);
  return lines.join("\n");
}
