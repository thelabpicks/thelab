import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Trophy } from "lucide-react";
import { STATIC } from "@/lib/api";
import { chicago, cn, pct } from "@/lib/format";
import { SPORTS, SURE, SPORT_LABEL, playDate, tally, type DailyPick, type LabBoard, type LabPick, type LabRecord, type Sport } from "@/lib/lab";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, LoadingBlock, Notice, Segmented } from "@/components/ui";
import { WriteUp } from "@/components/WriteUp";

const URL = STATIC ? `${import.meta.env.BASE_URL}data/lab/board.json` : "/api/lab/board.json";

async function getBoard(): Promise<LabBoard> {
  const r = await fetch(URL);
  if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error("The Lab's picks are built on each site refresh and are not published yet.");
  return r.json();
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" });
const price = (p: number | null) => (p == null ? "" : p > 0 ? `+${p}` : String(p));

/** Each sport's best plays, ranked 1 to 10 by chance to hit, each with its full write-up. */
export default function LabPicks() {
  const q = useQuery({ queryKey: ["lab-board"], queryFn: getBoard, staleTime: 5 * 60_000 });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [sp, setSp] = useSearchParams();
  const sport: Sport = SPORTS.includes(sp.get("sport") as Sport) ? (sp.get("sport") as Sport) : "nfl";
  const b = q.data;
  const board = (b?.board ?? []).filter((p) => p.sport === sport);
  const note = b?.notes?.[sport];
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="space-y-5">
      <PageTitle kicker={b ? `Updated ${chicago(b.generated_at)}` : "Every sport"} title={`The Lab's top 10: ${SPORT_LABEL[sport]}`} />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Each sport's 10 plays most likely to win, ranked by their chance to hit from 5,000-game simulations: #1 is the surest. Picks at 70%+
        are marked sure plays. Tap a pick for the full write-up.
      </p>
      <Notice tone="info" title="Live lines coming soon">
        Live sportsbook lines aren't pulling in for now, so some picks use a player's usual line. Check your book's line before betting. Live lines are coming soon.
      </Notice>
      {b?.daily && <DailyCard b={b} />}

      <Segmented label="Sport" value={sport} onChange={(v) => setSp({ sport: v }, { replace: true })}
        options={SPORTS.map((s) => ({ value: s, label: `${SPORT_LABEL[s]}${b ? ` · ${b.board.filter((p) => p.sport === s).length}` : ""}` }))} />
      {q.isLoading && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {q.isError && <Notice title="Not published yet">{(q.error as Error).message}</Notice>}
      {b && !b.sports[sport]?.loaded && <Notice tone="warn" title={`${SPORT_LABEL[sport]} numbers were not available on the last refresh`}>The list comes back with the next refresh.</Notice>}
      {b && b.sports[sport]?.loaded && note && <Notice tone="info">{note}{!board.length ? " Picks appear as lines are posted and the sport refreshes." : ""}</Notice>}

      {!!board.length && (
        <Card className="overflow-hidden">
          <ol className="divide-y divide-line/60">
            {board.map((p) => <PickRow key={p.id} p={p} open={open.has(p.id)} onToggle={() => toggle(p.id)} />)}
          </ol>
        </Card>
      )}

      {b && <RecordCard b={b} sport={sport} />}

      <Card><CardBody className="space-y-1.5 text-xs text-muted">
        <p><b className="text-fg">How the list is made.</b> Each sport has its own list. It draws only on the picks that sport already features: NFL and NBA props from confidence tiers that hit 50%+ on unseen games (NBA only at prop lines a book really posts),
          and in college, each game's favorite to win outright plus bets rated 7+. The 10 with the best chance to hit make the list (simulated, then calibrated against how similar
          picks really did), highest first, and 70%+ picks are marked sure plays. Ties go to a real sportsbook line, then to the tier's tested record. One pick per game and per player.
          When the books' feed carries alternate lines (a paid odds plan), they count too: only lines a book posts, priced -500 or longer, that the sims give a better chance than the price implies.
          College spreads and totals are set near 50/50, so they top out around 55%; the surest college picks are big favorites to win, which pay little. Even a 90% pick loses 1 time in 10: the "tested" figure on each pick is how often its tier actually hit on games the models never saw.</p>
        <p>The list refreshes with each sport's data (latest box scores, injury reports and lines). A pick on the list when its game starts is frozen exactly as shown and graded after the final.
          Research, not betting advice. No pick is guaranteed.</p>
      </CardBody></Card>
    </div>
  );
}

function PickRow({ p, open, onToggle }: { p: LabPick; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-raised/50 sm:items-center sm:px-5">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-display text-lg font-bold",
          p.rank === 1 ? "bg-accent text-accent-fg" : "bg-accent/10 text-accent")}>{p.rank}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <SportBadge sport={p.sport} />
            <span className="font-semibold leading-snug">{p.bet}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted">{p.matchup} · {when(p.kickoff)}{p.line_source === "usual" ? " · usual line, check your book" : ""}</div>
          <div className="mt-1 hidden text-sm text-muted sm:block">{p.headline}</div>
        </div>
        <div className="shrink-0 text-right">
          <div><span className="font-display text-xl font-bold">{pct(p.chance, 0)}</span> <span className="text-xs text-muted">to hit</span></div>
          {p.chance >= SURE && !p.result && <div className="text-[11px] font-semibold text-accent">Sure play</div>}
          {p.price != null && <div className="text-xs text-muted">{price(p.price)}{p.book ? ` ${p.book}` : ""}</div>}
          {p.result ? <ResultBadge p={p} /> : p.tier && <div className="text-[11px] text-muted">{p.tier}{p.tier_rate != null ? ` · ${pct(p.tier_rate, 0)} tested` : ""}</div>}
        </div>
        <ChevronDown className={cn("mt-2 h-4 w-4 shrink-0 text-muted transition-transform sm:mt-0", open && "rotate-180")} aria-hidden />
      </button>
      <div className="-mt-1 px-4 pb-3 pl-16 text-sm text-muted sm:hidden">{p.headline}</div>
      {open && (
        <div className="border-t border-line/60 bg-bg/30">
          <WriteUp sections={p.sections} />
          <div className="px-4 py-2.5 text-xs sm:px-5"><Link to={p.link} className="text-accent hover:underline">{p.link.includes("/players/") ? "Game-by-game stats →" : `Open in ${SPORT_LABEL[p.sport]}`}</Link></div>
        </div>
      )}
    </li>
  );
}

const SPORT_TONE: Record<Sport, "accent" | "info" | "warn"> = { nfl: "accent", cfb: "info", nba: "warn" };
function SportBadge({ sport }: { sport: Sport }) {
  return <Badge tone={SPORT_TONE[sport]}>{SPORT_LABEL[sport]}</Badge>;
}

function ResultBadge({ p }: { p: LabPick }) {
  const tone = p.result === "won" ? "ok" : p.result === "lost" ? "danger" : "neutral";
  const label = { won: "Hit", lost: "Miss", push: "Push", void: "Void" }[p.result!];
  return <Badge tone={tone} title={p.actual}>{label}</Badge>;
}

const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

/** The text of one sport's picks of the day, ready to post. */
function postText(sport: Sport, date: string, ps: DailyPick[], r: LabRecord): string {
  const lines = ps.map((p) => `${p.slot}. ${p.bet} (${p.matchup}): ${pct(p.chance, 0)} to hit`);
  return [`The Lab's ${SPORT_LABEL[sport]} picks of the day, ${day(date)}`, ...lines, r.n ? `Picks of the day: ${recText(r)} (${pct(r.rate ?? 0, 0)})` : ""].filter(Boolean).join("\n");
}

/** Each sport's 3 likeliest picks for today (and tomorrow, once chosen), locked when chosen and tracked separately. */
function DailyCard({ b }: { b: LabBoard }) {
  const [copied, setCopied] = React.useState<string | null>(null);
  const groups = new Map<string, DailyPick[]>();
  for (const p of b.daily.picks) groups.set(`${p.date}|${p.sport}`, [...(groups.get(`${p.date}|${p.sport}`) ?? []), p]);
  const rec = b.daily.record;
  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 2000); }, () => {});
  };
  return (
    <Card>
      <CardHeader title="Picks of the day" icon={<Trophy className="h-4 w-4 text-accent" />}
        subtitle={`Each sport's 3 likeliest picks for the day, locked when chosen and graded after the final. Record: ${recText(rec)}${rec.rate != null ? ` (${pct(rec.rate, 0)})` : ""}`} />
      {!groups.size && <CardBody><p className="text-sm text-muted">Today's picks post once the sport's games have lines; they stay put once chosen.</p></CardBody>}
      {[...groups.entries()].map(([key, ps]) => {
        const sport = ps[0].sport, date = ps[0].date;
        return (
          <div key={key} className="border-t border-line/60">
            <div className="flex items-center justify-between gap-3 px-4 pt-3 sm:px-5">
              <div className="flex items-center gap-2 text-sm font-semibold"><SportBadge sport={sport} />{date === b.daily.today ? "Today" : day(date)}
                <span className="text-xs font-normal text-muted">{recText(rec.by_sport[sport])}</span></div>
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => copy(key, postText(sport, date, ps, rec.by_sport[sport]))}>
                {copied === key ? "Copied" : "Copy for posting"}</button>
            </div>
            <ol className="divide-y divide-line/40">
              {ps.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
                  <span className="w-5 shrink-0 text-center font-display font-bold text-accent">{p.slot}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug">{p.bet}</div>
                    <div className="text-xs text-muted">{p.matchup} · {when(p.kickoff)}{p.line_source === "usual" ? " · usual line, check your book" : ""}</div>
                  </div>
                  <span className="text-sm font-semibold">{pct(p.chance, 0)}</span>
                  {p.result && <ResultBadge p={p} />}
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </Card>
  );
}

const recText = (r: LabRecord) => (r.n ? `${r.won}-${r.lost}${r.push ? `-${r.push}` : ""}` : "–");

/** Every pick that was on the list at kickoff (and every pick of the day), graded after the final: hit or miss, by day. */
function RecordCard({ b, sport: shown }: { b: LabBoard; sport: Sport }) {
  // flips between sports on its own, starting on the sport the page shows
  const [sport, setSport] = React.useState<Sport>(shown);
  React.useEffect(() => setSport(shown), [shown]);
  const r = b.record.by_sport[sport];
  const dr = b.daily?.record.by_sport[sport];
  const recent = b.recent.filter((p) => p.sport === sport);
  const potd = new Map((b.daily ? [...b.daily.recent, ...b.daily.picks] : []).filter((d) => d.sport === sport).map((d) => [`${d.game_id}|${d.bet}`, d]));
  // picks of the day that never made the top 10 still belong in the results
  const rows: (LabPick & { day?: number })[] = [...recent];
  const seen = new Set(recent.map((p) => `${p.game_id}|${p.bet}`));
  potd.forEach((d, k) => { if (!seen.has(k) && new Date(d.kickoff) <= new Date(b.generated_at)) rows.push(d); });
  const byDay = new Map<string, LabPick[]>();
  for (const p of rows.sort((x, y) => y.kickoff.localeCompare(x.kickoff))) {
    const d = playDate(p.kickoff); byDay.set(d, [...(byDay.get(d) ?? []), p]);
  }
  const pending = rows.filter((p) => !p.result).length;
  return (
    <Card>
      <CardHeader title={`${SPORT_LABEL[sport]} results`} icon={<Trophy className="h-4 w-4 text-accent" />}
        subtitle="Every pick that was on the list when its game started, graded after the final. Picks are never changed after kickoff." />
      <CardBody className="space-y-3">
        <Segmented size="sm" label="Results for" value={sport} onChange={(v) => setSport(v as Sport)}
          options={SPORTS.map((s) => ({ value: s, label: `${SPORT_LABEL[s]} · ${recText(b.record.by_sport[s])}` }))} />
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div><div className="label">Top 10</div><div className="font-display text-xl font-bold">{recText(r)}{r.rate != null && <span className="ml-1.5 text-sm font-semibold text-muted">{pct(r.rate, 0)}</span>}</div></div>
          {dr && <div><div className="label">Picks of the day</div><div className="font-display text-xl font-bold">{recText(dr)}{dr.rate != null && <span className="ml-1.5 text-sm font-semibold text-muted">{pct(dr.rate, 0)}</span>}</div></div>}
        </div>
        {!rows.length && <p className="text-sm text-muted">Results show here once the first games on the list are played.</p>}
        {pending > 0 && <p className="text-xs text-muted">{pending} {pending === 1 ? "pick is" : "picks are"} waiting on a final score.</p>}
      </CardBody>
      {[...byDay.entries()].map(([d, ps]) => {
        const t = tally(ps);
        return (
          <div key={d} className="border-t border-line">
            <div className="flex items-center justify-between bg-raised/40 px-4 py-1.5 text-xs font-semibold sm:px-5">
              <span>{day(d)}</span><span className="text-muted">{t.n ? `${recText(t)} that day` : "Pending"}</span>
            </div>
            <ul className="divide-y divide-line/60">
              {ps.map((p) => {
                const daily = potd.get(`${p.game_id}|${p.bet}`);
                return (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
                    <ResultMark p={daily?.result ? daily : p} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium leading-snug">{p.bet}{daily && <span className="ml-1.5 rounded bg-accent/10 px-1 py-px text-[10px] font-semibold text-accent">Pick of the day</span>}</div>
                      <div className="truncate text-xs text-muted">{p.matchup} · {when(p.kickoff)}{(daily?.actual ?? p.actual) ? ` · ${daily?.actual ?? p.actual}` : ""}</div>
                    </div>
                    <span className="text-xs text-muted">{pct(p.chance, 0)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </Card>
  );
}

/** A big hit / miss mark for the results list. */
function ResultMark({ p }: { p: LabPick }) {
  const r = p.result;
  const [txt, cls] = r === "won" ? ["✓", "bg-ok/15 text-ok"] : r === "lost" ? ["✗", "bg-danger/15 text-danger"]
    : r === "push" ? ["P", "bg-raised text-muted"] : r === "void" ? ["–", "bg-raised text-muted"] : ["…", "bg-raised text-muted"];
  const label = r ? { won: "Hit", lost: "Miss", push: "Push", void: "Void (did not play)" }[r] : "Pending";
  return <span title={label} aria-label={label} className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold", cls)}>{txt}</span>;
}
