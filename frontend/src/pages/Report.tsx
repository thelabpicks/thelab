import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, FlaskConical, GitMerge, ListChecks, Trophy, Wrench } from "lucide-react";
import { STATIC } from "@/lib/api";
import { chicago, cn, pct } from "@/lib/format";
import { SPORT_LABEL } from "@/lib/lab";
import { longDay, recText, reportText, type Check, type DailyReport, type ReportIndex, type ReportPick, type SportReport } from "@/lib/report";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody, CardHeader, LoadingBlock, Notice, Select } from "@/components/ui";

const BASE = STATIC ? `${import.meta.env.BASE_URL}data/lab/reports` : "/api/lab/reports";

async function getJson<T>(file: string): Promise<T> {
  const r = await fetch(`${BASE}/${file}`);
  if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error("The daily report is written by each morning's site refresh and is not published yet.");
  return r.json();
}

/** The daily model report: each morning's results, pre-game cross-checks, post-game reviews and model changes. */
export default function Report() {
  const [sp, setSp] = useSearchParams();
  const idx = useQuery({ queryKey: ["report-index"], queryFn: () => getJson<ReportIndex>("index.json"), staleTime: 5 * 60_000 });
  const date = sp.get("date") || idx.data?.latest || null;
  const rep = useQuery({ queryKey: ["report", date], queryFn: () => getJson<DailyReport>(`${date}.json`), enabled: !!date, staleTime: 5 * 60_000 });
  const r = rep.data;
  const [copied, setCopied] = React.useState(false);
  const copy = () => r && navigator.clipboard?.writeText(reportText(r, `${location.origin}${import.meta.env.BASE_URL}`)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => {});
  return (
    <div className="space-y-5">
      <PageTitle kicker={r ? `Updated ${chicago(r.generated_at)}` : "Every sport"} title="Daily report">
        {!!idx.data?.reports.length && (
          <Select aria-label="Report date" value={date ?? ""} onChange={(e) => setSp({ date: e.target.value }, { replace: true })}>
            {idx.data.reports.map((x) => <option key={x.date} value={x.date}>{longDay(x.date)}</option>)}
          </Select>
        )}
      </PageTitle>
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Written by the 4 am refresh every morning and updated by later refreshes: how yesterday's picks did, what was checked before the games,
        what the post-game re-runs found, and what changed in the models.
      </p>
      {(idx.isLoading || rep.isLoading) && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {(idx.isError || rep.isError) && <Notice title="Not published yet">{((idx.error || rep.error) as Error).message}</Notice>}
      {r && (
        <>
          <Card>
            <CardHeader title={`Results from ${longDay(r.results_date)}`} icon={<Trophy className="h-4 w-4 text-accent" />} subtitle={r.headline}
              action={<button type="button" className="text-xs text-accent hover:underline" onClick={copy}>{copied ? "Copied" : "Copy as text"}</button>} />
            <CardBody>
              <div className="grid grid-cols-3 gap-3 text-sm">
                {r.sports.map((s) => (
                  <div key={s.sport} className="rounded-lg border border-line p-3">
                    <div className="label">{SPORT_LABEL[s.sport]}</div>
                    <div className="mt-1 font-display text-xl font-bold">{recText(s.record.top10)}</div>
                    <div className="text-xs text-muted">Top 10 season</div>
                    <div className="mt-1.5 font-semibold">{recText(s.record.potd)}</div>
                    <div className="text-xs text-muted">Picks of the day</div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
          {r.sports.map((s) => <SportCard key={s.sport} s={s} />)}
          {!!r.changes.length && (
            <Card>
              <CardHeader title="Shipped since the last report" icon={<GitMerge className="h-4 w-4 text-accent" />} />
              <ul className="divide-y divide-line/60 text-sm">
                {r.changes.map((c) => <li key={c.url} className="px-4 py-2 sm:px-5"><a href={c.url} className="hover:underline" target="_blank" rel="noreferrer">{c.title}</a></li>)}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function SportCard({ s }: { s: SportReport }) {
  const day = [...s.results, ...s.pending.filter((p) => !s.results.some((x) => x.id === p.id))];
  return (
    <Card>
      <CardHeader title={SPORT_LABEL[s.sport]} icon={<Trophy className="h-4 w-4 text-accent" />}
        subtitle={`Yesterday: top 10 ${recText(s.day.top10)}, picks of the day ${recText(s.day.potd)} · Season: ${recText(s.record.top10)} / ${recText(s.record.potd)}`} />
      {!!day.length && (
        <ul className="divide-y divide-line/60 border-t border-line">
          {day.map((p) => <PickLine key={p.id} p={p} />)}
        </ul>
      )}
      <CardBody className="space-y-4 border-t border-line">
        <Section icon={<ListChecks className="h-4 w-4" />} title="Findings on the games" items={s.findings} />
        <ChecksSection checks={s.checks} />
        <Section icon={<FlaskConical className="h-4 w-4" />} title="Post-game grading and re-runs" items={s.postgame} />
        <Section icon={<Wrench className="h-4 w-4" />} title="How the model is improving" items={s.improving} />
        {!!s.today.length && <Section icon={<Trophy className="h-4 w-4" />} title="Today's picks of the day" items={s.today.map((p) => `${p.bet} (${p.matchup}): ${pct(p.chance, 0)} to hit`)} />}
      </CardBody>
    </Card>
  );
}

function Section({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-accent">{icon}{title}</div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

function ChecksSection({ checks }: { checks: Check[] }) {
  if (!checks.length) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-accent"><ClipboardCheck className="h-4 w-4" />Pre-game cross-checks</div>
      <ul className="space-y-1 text-sm text-muted">
        {checks.map((c, i) => (
          <li key={i} className="flex gap-2">
            <span className={cn("mt-0.5 shrink-0 font-bold", c.ok === true ? "text-ok" : c.ok === false ? "text-warn" : "text-muted")}>{c.ok === true ? "✓" : c.ok === false ? "!" : "•"}</span>
            <span>{c.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PickLine({ p }: { p: ReportPick }) {
  const r = p.result;
  const [txt, cls] = r === "won" ? ["✓", "bg-ok/15 text-ok"] : r === "lost" ? ["✗", "bg-danger/15 text-danger"] : r === "push" ? ["P", "bg-raised text-muted"]
    : r === "void" ? ["–", "bg-raised text-muted"] : ["…", "bg-raised text-muted"];
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
      <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold", cls)}>{txt}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-snug">{p.bet}
          {p.potd && <span className="ml-1.5 rounded bg-accent/10 px-1 py-px text-[10px] font-semibold text-accent">Pick of the day</span>}
          {p.rank != null && <span className="ml-1.5 text-[10px] font-semibold text-muted">Top 10 #{p.rank}</span>}</div>
        <div className="truncate text-xs text-muted">{p.matchup}{p.actual ? ` · ${p.actual}` : " · waiting on the final"}</div>
      </div>
      <span className="text-xs text-muted">{pct(p.chance, 0)}</span>
    </li>
  );
}
