/* A player's games one by one, the same card in every sport: pick a stat, see each game as a bar with this week's prop
   line across it (green bars went over, red stayed under), the over count, and every game in a table below. Each
   sport's player page turns its own published log into LogGame rows; nothing here is projected. */
import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn, num, pct } from "@/lib/format";
import { Card, CardBody, CardHeader, Segmented, TableWrap, Td, Th } from "@/components/ui";
import { ResultMark } from "@/components/PreviousWeeks";

export type LogStat = { key: string; label: string; short: string; line?: number | null; lineNote?: string };
/** One game. when: "W7" or "Oct 24"; values keyed by LogStat.key. */
export type LogGame = { id: string; when: string; opp: string; season?: string; values: Record<string, number | null | undefined> };

const result = (v: number | null | undefined, line: number | null | undefined) =>
  v == null || line == null ? null : v > line ? "won" as const : v < line ? "lost" as const : "push" as const;

export function GameByGame({ stats, games, initial, subtitle, extra }: {
  stats: LogStat[];
  /** Oldest first. */
  games: LogGame[];
  initial?: string;
  subtitle?: string;
  /** Columns shown in the table after the stats (minutes, snap share). */
  extra?: { label: string; value: (g: LogGame) => React.ReactNode }[];
}) {
  const shown = stats.filter((s) => games.some((g) => g.values[s.key] != null));
  const [key, setKey] = React.useState(initial && shown.some((s) => s.key === initial) ? initial : shown[0]?.key);
  const seasons = [...new Set(games.map((g) => g.season).filter((s): s is string => !!s))];
  const [scope, setScope] = React.useState<"season" | "all">("season");
  const now = seasons[seasons.length - 1];
  const list = seasons.length > 1 && scope === "season" ? games.filter((g) => g.season === now) : games;
  const stat = shown.find((s) => s.key === key) ?? shown[0];
  if (!stat || !list.length) {
    return (
      <Card><CardHeader title="Game by game" /><CardBody className="text-sm text-muted">No games played yet this season.</CardBody></Card>
    );
  }
  const line = stat.line ?? null;
  const vals = list.map((g) => g.values[stat.key]).filter((v): v is number => v != null);
  const overs = line == null ? 0 : vals.filter((v) => v > line).length;
  const graded = line == null ? 0 : vals.filter((v) => v !== line).length;
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const data = list.map((g) => ({ when: g.when, opp: g.opp, v: g.values[stat.key] ?? null, r: result(g.values[stat.key], line) }));
  const color = (r: ReturnType<typeof result>) => (r === "won" ? "rgb(var(--ok))" : r === "lost" ? "rgb(var(--danger))" : r === "push" ? "rgb(var(--muted))" : "rgb(var(--accent))");
  return (
    <Card>
      <CardHeader title="Game by game" subtitle={subtitle ?? (line != null ? "Each game against this week's line. Green went over, red stayed under." : "Each game this season.")}
        action={seasons.length > 1 ? <Segmented size="sm" label="Which games" value={scope} onChange={setScope}
          options={[{ value: "season", label: "This season" }, { value: "all", label: `Last ${games.length}` }]} /> : undefined} />
      <CardBody className="space-y-4">
        <div role="radiogroup" aria-label="Stat" className="flex flex-wrap gap-1.5">
          {shown.map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={s.key === stat.key} onClick={() => setKey(s.key)}
              className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                s.key === stat.key ? "border-accent bg-accent text-accent-fg" : "border-line text-muted hover:text-fg")}>{s.label}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          {line != null ? (
            <div>
              <div className="label">Over {line} {stat.label.toLowerCase()}</div>
              <div className="font-display text-2xl font-semibold">{overs} of {graded} <span className="text-base font-normal text-muted">{graded ? `(${pct(overs / graded, 0)})` : ""}</span></div>
              {stat.lineNote && <div className="text-xs text-muted">{stat.lineNote}</div>}
            </div>
          ) : <div className="text-sm text-muted">No line this week for {stat.label.toLowerCase()}.</div>}
          <div><div className="label">Average</div><div className="font-display text-2xl font-semibold">{num(avg, 1)}</div></div>
          <div><div className="label">High · Low</div><div className="font-display text-2xl font-semibold">{vals.length ? `${num(Math.max(...vals), 0)} · ${num(Math.min(...vals), 0)}` : "—"}</div></div>
        </div>
        <div className="h-56" role="img" aria-label={`${stat.label} in each game${line != null ? `, with the ${line} line` : ""}. The table below lists the same values.`}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ left: -20, right: 8, top: 18 }}>
              <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
              <XAxis dataKey="when" tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: "rgb(var(--raised))" }} contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 8, fontSize: 12 }}
                formatter={(v: number) => [num(v, 0), stat.label]} labelFormatter={(l, p) => `${l} ${p?.[0]?.payload?.opp ?? ""}`} />
              <Bar dataKey="v" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {data.map((d, i) => <Cell key={i} fill={color(d.r)} />)}
                {data.length <= 12 && <LabelList dataKey="v" position="top" style={{ fill: "rgb(var(--fg))", fontSize: 11 }} formatter={(v: number) => num(v, 0)} />}
              </Bar>
              {line != null && <ReferenceLine y={line} stroke="rgb(var(--fg))" strokeDasharray="5 4" strokeWidth={1.5}
                label={{ value: `Line ${line}`, position: "insideTopRight", fill: "rgb(var(--fg))", fontSize: 11 }} />}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardBody>
      <TableWrap>
        <table className="w-full text-sm">
          <thead><tr><Th>Game</Th><Th>Opp</Th>
            {shown.map((s) => <Th key={s.key} className={cn("text-right", s.key === stat.key && "text-fg")}>{s.short}</Th>)}
            {extra?.map((x) => <Th key={x.label} className="text-right">{x.label}</Th>)}{line != null && <Th className="text-center">vs {line}</Th>}</tr></thead>
          <tbody>
            {[...list].reverse().map((g) => (
              <tr key={g.id} className="border-b border-line/60">
                <Td className="whitespace-nowrap text-muted">{g.when}</Td><Td className="whitespace-nowrap">{g.opp}</Td>
                {shown.map((s) => <Td key={s.key} className={cn("text-right", s.key === stat.key ? "font-semibold" : "text-muted")}>{g.values[s.key] == null ? "—" : num(g.values[s.key], 0)}</Td>)}
                {extra?.map((x) => <Td key={x.label} className="text-right text-muted">{x.value(g)}</Td>)}
                {line != null && <Td><div className="flex justify-center"><ResultMark r={result(g.values[stat.key], line)} /></div></Td>}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}
