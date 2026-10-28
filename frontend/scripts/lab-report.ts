/* Writes the daily model report (src/lib/report.ts) after The Lab's picks are rebuilt (run by the "Refresh data and
   publish site" workflow right after lab-picks.ts):

     LAB_DATA=../site-data LAB_ARCHIVE=../pick-archive/lab REPORT_COLLECT=/tmp/collect npx vite-node scripts/lab-report.ts

   Every run rewrites the report for today's date (Central time), so the 4 am refresh writes the first one of the day and
   later refreshes add late grades. Reports are kept in LAB_ARCHIVE/reports/ (the nfl-data branch) and published to
   LAB_DATA/lab/reports/ for the /report page. REPORT_COLLECT holds the collect workflows' status files (nba-status.json,
   cfb-status.json) when the workflow could fetch them; GITHUB_TOKEN and GITHUB_REPOSITORY list what shipped since the last
   report. Reports written by hand before this ran (scripts/report-seed/) are copied in once. Nothing here stops the site
   from publishing. */
import fs from "node:fs";
import path from "node:path";
import { staticKey } from "../src/lib/static";
import type { LabState } from "../src/lib/lab";
import type { NbaRecord, NbaStatus } from "../src/lib/nba";
import type { CfbRecord } from "../src/lib/cfb";
import type { LiveRecord } from "../src/components/LiveRecord";
import { addToIndex, buildReport, type Change, type CollectStatus, type DailyReport, type ReportIndex } from "../src/lib/report";

const DATA = path.resolve(process.env.LAB_DATA || "../site-data");
const ARCHIVE = path.resolve(process.env.LAB_ARCHIVE || "../data/lab");
const COLLECT = process.env.REPORT_COLLECT ? path.resolve(process.env.REPORT_COLLECT) : null;
const SEED = path.resolve("scripts/report-seed");   // run from frontend/
const DIR = path.join(ARCHIVE, "reports");

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
const data = <T>(file: string) => readJson<T>(path.join(DATA, file));
const collect = (name: string) => (COLLECT ? readJson<CollectStatus>(path.join(COLLECT, name)) : null);

/** Pull requests merged into main since `since`, from the merge commits' messages ("Merge pull request #N ...\n\nTitle"). */
async function changesSince(since: string | null): Promise<Change[]> {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token || !since) return [];
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/commits?sha=main&per_page=50&since=${encodeURIComponent(since)}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
    if (!r.ok) return [];
    const commits = (await r.json()) as { sha: string; html_url: string; commit: { message: string; committer: { date: string } } }[];
    return commits.filter((c) => c.commit.message.startsWith("Merge pull request #")).map((c) => {
      const [head, , ...rest] = c.commit.message.split("\n");
      const n = head.match(/#(\d+)/)?.[1];
      return { title: `${rest.join(" ").trim() || head} (#${n})`, url: `https://github.com/${repo}/pull/${n}`, at: c.commit.committer.date };
    });
  } catch { return []; }
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of fs.existsSync(SEED) ? fs.readdirSync(SEED) : []) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && !fs.existsSync(path.join(DIR, f))) fs.copyFileSync(path.join(SEED, f), path.join(DIR, f));
  }
  const state = readJson<LabState>(path.join(ARCHIVE, "state.json"));
  if (!state) { console.warn("report: no Lab state yet, skipped"); return; }
  const now = new Date();
  const files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const prevFile = files.filter((f) => f < `${today}.json`).at(-1);
  const previous = prevFile ? readJson<DailyReport>(path.join(DIR, prevFile)) : null;
  const existing = readJson<DailyReport>(path.join(DIR, `${today}.json`));
  // today's report lists what shipped since yesterday's report, however many refreshes rewrite it
  const changes = await changesSince(previous?.generated_at ?? existing?.generated_at ?? null);
  const report = buildReport({
    state, previous, changes,
    nfl: data<LiveRecord>(staticKey("/backtest/live")),
    nba: { record: data<NbaRecord>("nba/record.json"), status: data<NbaStatus>("nba/status.json"), collect: collect("nba-status.json") },
    cfb: { record: data<CfbRecord>("cfb/record.json"), collect: collect("cfb-status.json") },
  }, now);
  if (!changes.length && existing?.changes?.length) report.changes = existing.changes;
  if (!existing?.manual) fs.writeFileSync(path.join(DIR, `${report.date}.json`), JSON.stringify(report));

  let idx: ReportIndex = { latest: null, reports: [] };
  for (const f of fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    const r = readJson<DailyReport>(path.join(DIR, f));
    if (r) idx = addToIndex(idx, r);
  }
  const out = path.join(DATA, "lab", "reports");
  fs.mkdirSync(out, { recursive: true });
  for (const x of idx.reports) fs.copyFileSync(path.join(DIR, `${x.date}.json`), path.join(out, `${x.date}.json`));
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(idx));
  console.log(`report: ${report.date} ${existing?.manual ? "kept (written by hand)" : `written (${report.headline})`}; ${idx.reports.length} reports published`);
}

main().catch((e) => console.warn(`report: skipped (${(e as Error).message})`));
