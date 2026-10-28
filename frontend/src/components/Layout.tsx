import * as React from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, BarChart3, BookOpen, Dices, MessageCircleQuestion, LayoutDashboard, ListOrdered, Moon, Settings, Shield, SlidersHorizontal, Sun, Percent, Menu, X, Trophy, FileText,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek, useTheme, type WeeksResponse } from "@/lib/state";
import { Select } from "./ui";
import { useLiveRecord } from "./LiveRecord";
import { useCfb, type CfbPrevious, type CfbStatus, type Week as CfbWeek } from "@/lib/cfb";
import { useNba, type NbaPrevious, type NbaStatus, type Slate } from "@/lib/nba";

type NavItem = { to: string; label: string; short?: string; icon: typeof LayoutDashboard; end?: boolean };
type NavSection = { title: string; items: NavItem[] };

/** Every sport gets the NFL tab's menu: the same sections, the same items in the same order, and the same mobile bar
 *  (Home, Props, Ask, Parlay, More). Only the sport's own research pages differ. */
function sportNav(base: string, home: string, research: NavItem[], links: { parlay: string; how: string; record: string }): NavSection[] {
  return [
    { title: "Picks", items: [
      { to: base || "/", label: home, short: "Home", icon: LayoutDashboard, end: true },
      { to: `${base}/ask`, label: "Ask", icon: MessageCircleQuestion },
      { to: links.parlay, label: "Parlay builder", short: "Parlay", icon: Dices },
    ] },
    { title: "Research", items: [{ to: `${base}/props`, label: "Player props", short: "Props", icon: SlidersHorizontal }, ...research] },
    { title: "Proof", items: [
      { to: links.how, label: "How it works", icon: BookOpen },
      { to: links.record, label: "Track record", icon: BarChart3 },
      { to: "/report", label: "Daily report", icon: FileText },
    ] },
    { title: "", items: [{ to: "/settings", label: "Settings", icon: Settings }] },
  ];
}
const NAV_BY_SPORT: Record<Sport, NavSection[]> = {
  nfl: sportNav("", "This week", [
    { to: "/rankings", label: "Anytime TD", short: "TDs", icon: ListOrdered },
    { to: "/hitrates", label: "Hit rates", icon: Percent },
    { to: "/defenses", label: "Defenses", icon: Shield },
  ], { parlay: "/builder", how: "/how", record: "/backtest" }),
  cfb: sportNav("/cfb", "This week", [
    { to: "/cfb/games", label: "All games", short: "Games", icon: ListOrdered },
    { to: "/cfb/teams", label: "Teams", icon: Trophy },
  ], { parlay: "/cfb/parlay", how: "/cfb/how", record: "/cfb/record" }),
  nba: sportNav("/nba", "Today", [], { parlay: "/nba/builder", how: "/nba/how", record: "/nba/record" }),
};
// Mobile bar: Home, Player props, Ask, Parlay builder (then More), whatever the sport.
const mobileNav = (sections: NavSection[]) => [sections[0].items[0], sections[1].items[0], sections[0].items[1], sections[0].items[2]];

type Sport = "nfl" | "nba" | "cfb";
const sportOf = (path: string): Sport => (path === "/nba" || path.startsWith("/nba/") ? "nba" : path === "/cfb" || path.startsWith("/cfb/") ? "cfb" : "nfl");

/** NFL / CFB / NBA switch, plus The Lab's top 10 across all three. Each sport keeps its own pages; the switch goes to that sport's home. */
function SportSwitch({ sport, top }: { sport: Sport; top: boolean }) {
  const base = "rounded-md px-2 py-1.5 text-sm font-bold tracking-wide transition-colors sm:px-3.5";
  const tab = (to: string, s: Sport, label: string) => (
    <NavLink to={to} role="tab" aria-selected={!top && sport === s} className={cn(base, !top && sport === s ? "bg-accent text-accent-fg" : "text-muted hover:bg-raised hover:text-fg")}>{label}</NavLink>
  );
  return (
    <div className="flex rounded-lg border border-line bg-surface p-1" role="tablist" aria-label="Sport">
      <NavLink to="/top10" role="tab" aria-selected={top} title="The Lab's top 10 picks across every sport"
        className={cn(base, "whitespace-nowrap", top ? "bg-accent text-accent-fg" : "text-accent hover:bg-raised")}>Top 10</NavLink>
      {tab("/", "nfl", "NFL")}{tab("/cfb", "cfb", "CFB")}{tab("/nba", "nba", "NBA")}
    </div>
  );
}

type Health = { data_loaded: boolean; ready: boolean; calibrated: boolean };

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-raised" />
        {/* Lab flask: neck, body and the liquid line */}
        <path d="M13 7h6M14 7v6.5L8.6 22.8A2 2 0 0 0 10.3 26h11.4a2 2 0 0 0 1.7-3.2L18 13.5V7" className="stroke-accent" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M11.2 19.5h9.6l2 3.4a1 1 0 0 1-.9 1.6H10.1a1 1 0 0 1-.9-1.6z" className="fill-accent" />
      </svg>
      {!compact && (
        <div className="leading-tight">
          <div className="font-display text-[15px] font-bold tracking-tight">The Lab</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Props · Sims · Data</div>
        </div>
      )}
    </div>
  );
}

/** Tuesday until rosters post, the new NFL week has no picks yet: the site shows the last week and says when the next posts. */
function NextWeekNote() {
  const { season, week, defaults } = useSeasonWeek();
  const next = defaults?.next_week;
  if (!next || season !== defaults?.current_season || week !== defaults?.current_week) return null;
  return (
    <div className="mb-4 rounded-lg border border-line bg-surface/60 px-3 py-2 text-sm text-muted">
      Week {next} picks post Thursday, once rosters are out. Showing Week {week} results until then.
    </div>
  );
}

function SeasonWeekPicker() {
  const { season, week, set } = useSeasonWeek();
  const weeks = useQuery({ queryKey: ["weeks", season], queryFn: () => api.get<WeeksResponse>("/weeks", { season }), staleTime: 60_000 });
  const seasons = weeks.data?.seasons ?? [season];
  // past weeks' graded picks: the header's way into Previous weeks, as on the other sports
  const live = useLiveRecord();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const results = (live.data?.previous_weeks ?? []).filter((w) => w.season === season).map((w) => `${w.season}-${w.week}`);
  const onPrev = loc.pathname === "/previous";
  const value = onPrev ? `r:${params.get("p") ?? results[0] ?? ""}` : String(week);
  const pick = (v: string) => (v.startsWith("r:") ? nav(`/previous?p=${encodeURIComponent(v.slice(2))}`) : onPrev ? nav(`/?season=${season}&week=${v}`) : set(season, Number(v)));
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="season-select">Season</label>
      <Select id="season-select" value={season} onChange={(e) => set(Number(e.target.value), Number(e.target.value) === weeks.data?.current_season ? weeks.data.current_week : 1)} className="hidden h-8 w-auto text-xs sm:block">
        {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
      </Select>
      <label className="sr-only" htmlFor="week-select">Week</label>
      <Select id="week-select" value={value} onChange={(e) => pick(e.target.value)} className="h-8 w-[5.5rem] text-xs sm:w-auto">
        <optgroup label="Picks">
          {(weeks.data?.weeks ?? [{ week, status: "", has_predictions: true }]).map((w) => (
            <option key={w.week} value={w.week} disabled={!w.has_predictions}>
              Week {w.week}{w.status === "upcoming" ? " · upcoming" : w.status === "in_progress" ? " · live" : ""}{!w.has_predictions ? " · no run" : ""}
            </option>
          ))}
        </optgroup>
        {!!results.length && (
          <optgroup label="Results">
            {results.map((k) => <option key={k} value={`r:${k}`}>Week {k.split("-")[1]} · results</option>)}
          </optgroup>
        )}
      </Select>
    </div>
  );
}

/** The NFL header's season and week pickers, for college football (weeks) and the NBA (days). The current week or
 *  slate opens the sport's home page; a past one opens Previous weeks on it. */
function SportPeriodPicker({ sport }: { sport: "cfb" | "nba" }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const cfb = sport === "cfb";
  const cPrev = useCfb<CfbPrevious>("previous.json", cfb);
  const cWeek = useCfb<CfbWeek>("week.json", cfb);
  const cStat = useCfb<CfbStatus>("status.json", cfb);
  const nPrev = useNba<NbaPrevious>("previous.json", !cfb);
  const nSlate = useNba<Slate>("slate.json", !cfb);
  const nStat = useNba<NbaStatus>("status.json", !cfb);
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  let season: string;
  let now: string | null;
  let past: { key: string; label: string }[];
  if (cfb) {
    season = String(cStat.data?.season ?? cPrev.data?.season ?? "");
    const w = cWeek.data?.games[0]?.week;
    now = w != null ? `Week ${w} · upcoming` : null;
    const seen = new Set<string>();
    past = [...(cPrev.data?.games ?? [])].reverse().flatMap((g) => {
      const key = `${g.season_type}-${g.week}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, label: g.season_type === "regular" ? `Week ${g.week}` : `Postseason ${g.week}` }];
    });
  } else {
    season = nStat.data?.season_label ?? "";
    now = nSlate.data?.date ? `${day(nSlate.data.date)} · next games` : null;
    past = (nPrev.data?.days ?? []).map((d) => ({ key: d.date, label: day(d.date) }));
  }
  const base = cfb ? "/cfb" : "/nba";
  const onPrev = loc.pathname === `${base}/previous`;
  const value = onPrev ? params.get("p") ?? past[0]?.key ?? "" : "now";
  if (!season && !now && !past.length) return null;
  return (
    <div className="flex items-center gap-1.5">
      {season && (<>
        <label className="sr-only" htmlFor="season-select">Season</label>
        <Select id="season-select" value={season} onChange={() => undefined} className="hidden h-8 w-auto text-xs sm:block">
          <option value={season}>{season}</option>
        </Select>
      </>)}
      <label className="sr-only" htmlFor="week-select">{cfb ? "Week" : "Day"}</label>
      <Select id="week-select" value={value} className="h-8 w-[5.5rem] text-xs sm:w-auto"
        onChange={(e) => nav(e.target.value === "now" ? base : `${base}/previous?p=${encodeURIComponent(e.target.value)}`)}>
        {now && <option value="now">{now}</option>}
        {past.map((p) => <option key={p.key} value={p.key}>{p.label} · results</option>)}
        {onPrev && value === "__all" && <option value="__all">Every {cfb ? "week" : "day"}</option>}
      </Select>
    </div>
  );
}

/** College football and NBA: the same chip as the NFL's, green when the sport has markets proven in testing. */
function SportStatusChip({ sport }: { sport: "cfb" | "nba" }) {
  const cfb = sport === "cfb";
  const c = useCfb<CfbStatus>("status.json", cfb);
  const n = useNba<NbaStatus>("status.json", !cfb);
  const ok = cfb ? (c.data ? Object.values(c.data.proven).some((t) => t.length) : null) : (n.data ? n.data.validated_markets.length > 0 : null);
  const label = ok == null ? "Checking" : ok ? "Model validated" : "Research ranks only";
  return (
    <NavLink to={cfb ? "/cfb/record" : "/nba/record"} className="hidden items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-fg sm:flex">
      <span className={cn("h-2 w-2 rounded-full", ok == null ? "bg-muted" : ok ? "bg-accent" : "bg-info")} aria-hidden />
      {label}
    </NavLink>
  );
}

function StatusChip() {
  const h = useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/health"), refetchInterval: 30_000 });
  const suffix = useLinkSuffix();
  const state = h.isError ? "offline" : !h.data ? "…" : !h.data.data_loaded ? "no-data" : h.data.calibrated ? "validated" : "research";
  const label = { offline: "API offline", "…": "Checking", "no-data": "Data not loaded", validated: "Model validated", research: "Research ranks only" }[state];
  const tone = state === "validated" ? "bg-accent" : state === "research" ? "bg-info" : state === "…" ? "bg-muted" : "bg-warn";
  return (
    <NavLink to={`/data${suffix}`} className="hidden items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-fg sm:flex">
      <span className={cn("h-2 w-2 rounded-full", tone)} aria-hidden />
      {label}
    </NavLink>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"));
  return (
    <button
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function Layout() {
  const suffix = useLinkSuffix();
  const [open, setOpen] = React.useState(false);
  const loc = useLocation();
  React.useEffect(() => setOpen(false), [loc.pathname]);
  const sport = sportOf(loc.pathname);
  const nba = sport === "nba";
  const cfb = sport === "cfb";
  const top = loc.pathname === "/top10";
  const other = sport !== "nfl" || top;   // NBA, CFB and top-10 pages carry no NFL season/week query
  const sections = NAV_BY_SPORT[sport];
  const mobile = mobileNav(sections);
  const link = (n: NavItem) => (
    <NavLink
      key={n.to}
      to={n.to + (other ? "" : suffix)}
      end={n.end}
      className={({ isActive }) =>
        cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg")
      }
    >
      {({ isActive }) => (
        <>
          <n.icon className={cn("h-4 w-4", isActive && "text-accent")} aria-hidden />
          {n.label}
        </>
      )}
    </NavLink>
  );
  return (
    <div className="flex min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface/40 px-3 py-4 lg:flex">
        <div className="px-2 pb-6"><Logo /></div>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5"><Sections sections={sections} link={link} /></nav>
        <div className="mt-4 rounded-lg border border-line p-3 text-[11px] leading-relaxed text-muted">
          <Activity className="mb-1 h-3.5 w-3.5 text-accent" aria-hidden />
          {nba ? "Basketball" : cfb ? "College football" : "Football"} research, not betting advice. No pick is guaranteed.
        </div>
      </aside>
      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <nav className="absolute left-0 top-0 flex h-full w-64 flex-col gap-0.5 bg-surface p-3">
            <div className="mb-4 flex items-center justify-between px-2"><Logo /><button aria-label="Close menu" onClick={() => setOpen(false)}><X className="h-5 w-5" /></button></div>
            <Sections sections={sections} link={link} />
          </nav>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 sm:gap-3 border-b border-line bg-bg/85 px-3 backdrop-blur sm:px-6">
          <button className="lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></button>
          {/* On phones the sport switch stands in for the logo so the header fits. */}
          <div className="hidden sm:block lg:hidden"><Logo compact /></div>
          <SportSwitch sport={sport} top={top} />
          <div className="flex-1" />
          {!other && <SeasonWeekPicker />}
          {!other && <div className="hidden sm:block"><StatusChip /></div>}
          {!top && sport !== "nfl" && <SportPeriodPicker sport={sport} />}
          {!top && sport !== "nfl" && <div className="hidden sm:block"><SportStatusChip sport={sport} /></div>}
          <ThemeToggle />
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-24 pt-5 sm:px-6 lg:pb-10">
          {!other && <NextWeekNote />}
          <Outlet />
        </main>
      </div>
      {/* Mobile bottom nav */}
      <nav aria-label="Primary mobile" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
        {mobile.map((n) => (
          <NavLink key={n.to} to={n.to + (other ? "" : suffix)} end={n.end}
            className={({ isActive }) => cn("flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium", isActive ? "text-accent" : "text-muted")}>
            <n.icon className="h-5 w-5" aria-hidden />
            {n.short ?? n.label}
          </NavLink>
        ))}
        <button onClick={() => setOpen(true)} className="flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium text-muted">
          <Menu className="h-5 w-5" aria-hidden />More
        </button>
      </nav>
    </div>
  );
}

function Sections({ sections, link }: { sections: NavSection[]; link: (n: NavItem) => React.ReactNode }) {
  return (
    <>
      {sections.map((s, i) => (
        <div key={s.title || i} className={cn(i > 0 && "mt-4", !s.title && "mt-auto border-t border-line pt-3")}>
          {s.title && <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted/80">{s.title}</div>}
          <div className="flex flex-col gap-0.5">{s.items.map(link)}</div>
        </div>
      ))}
    </>
  );
}

export function PageTitle({ title, kicker, children }: { title: string; kicker?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {kicker && <div className="label mb-1">{kicker}</div>}
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-[28px]">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
