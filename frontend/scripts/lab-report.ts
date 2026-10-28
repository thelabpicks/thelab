/* Writes the daily model report (src/lib/report.ts) after The Lab's picks are rebuilt (run by the "Refresh data and
   publish site" workflow right after lab-picks.ts):

     LAB_DATA=../site-data LAB_ARCHIVE=../pick-archive/lab npx vite-node scripts/lab-report.ts

   Every run rewrites the report for today's date (Central time), so the 4 am refresh writes the first one of the day and
   later refreshes add late grades. Reports are kept in LAB_ARCHIVE/reports/ (the nfl-data branch) as JSON and plain
   text; the daily post to Andrew in the project chat is written from them. They are not published on the site.
   Reports written by hand before this ran (scripts/report-seed/) are copied in once and never rewritten. Nothing here
   stops the site from publishing. */
import fs from "node:fs";
import path from "node:path";
import { staticKey } from "../src/lib/static";
import type { LabState } from "../src/lib/lab";
import type { NbaPrevious, NbaRecord, NbaStatus } from "../src/lib/nba";
import type { CfbPrevious, CfbRecord } from "../src/lib/cfb";
import type { LiveRecord } from "../src/components/LiveRecord";
import { buildReport, reportText, type DailyReport } from "../src/lib/report";

const DATA = path.resolve(process.env.LAB_DATA || "../site-data");
const ARCHIVE = path.resolve(process.env.LAB_ARCHIVE || "../data/lab");
const SEED = path.resolve("scripts/report-seed");   // run from frontend/
const DIR = path.join(ARCHIVE, "reports");
const DATED = /^\d{4}-\d{2}-\d{2}\.json$/;

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
const data = <T>(file: string) => readJson<T>(path.join(DATA, file));

fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.existsSync(SEED) ? fs.readdirSync(SEED) : []) {
  if (DATED.test(f) && !fs.existsSync(path.join(DIR, f))) fs.copyFileSync(path.join(SEED, f), path.join(DIR, f));
}
const state = readJson<LabState>(path.join(ARCHIVE, "state.json"));
if (!state) {
  console.warn("report: no Lab state yet, skipped");
} else {
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const prevFile = fs.readdirSync(DIR).filter((f) => DATED.test(f) && f < `${today}.json`).sort().at(-1);
  const existing = readJson<DailyReport>(path.join(DIR, `${today}.json`));
  const report = existing?.manual ? existing : buildReport({
    state, previous: prevFile ? readJson<DailyReport>(path.join(DIR, prevFile)) : null,
    nfl: data<LiveRecord>(staticKey("/backtest/live")),
    nba: { record: data<NbaRecord>("nba/record.json"), status: data<NbaStatus>("nba/status.json"), previous: data<NbaPrevious>("nba/previous.json") },
    cfb: { record: data<CfbRecord>("cfb/record.json"), previous: data<CfbPrevious>("cfb/previous.json") },
  }, now);
  fs.writeFileSync(path.join(DIR, `${report.date}.json`), JSON.stringify(report));
  fs.writeFileSync(path.join(DIR, `${report.date}.txt`), reportText(report));
  console.log(`report: ${report.date} ${existing?.manual ? "kept (written by hand)" : "written"}: ${report.headline}`);
}
