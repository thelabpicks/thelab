import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MessageCircleQuestion } from "lucide-react";
import { num } from "@/lib/format";
import { useCfb, type Backtest, type Props, type Teams, type Week } from "@/lib/cfb";
import { answer, suggestionsFor } from "@/lib/cfbAsk";
import { PageTitle } from "@/components/Layout";
import { Button, Card, CardHeader, Input, LoadingBlock } from "@/components/ui";
import { WriteUp } from "@/components/WriteUp";
import { AiCard, AiKeyLink, AiToggle, KeyPanel, useAiAnswer, useAiMode } from "@/components/AiAsk";
import { LeanRow, NotPublished, RatingMeter } from "./shared";

export default function CfbAsk() {
  const [sp, setSp] = useSearchParams();
  const asked = sp.get("q") ?? "";
  const [q, setQ] = React.useState(asked);
  const week = useCfb<Week>("week.json");
  const teams = useCfb<Teams>("teams.json");
  const props = useCfb<Props>("props.json");
  const bt = useCfb<Backtest>("backtest.json");
  const ask = (text: string) => { setQ(text); setSp({ q: text }, { replace: true }); };
  const ai = useAiMode();
  const a = React.useMemo(() => (asked && week.data ? answer(asked, week.data, teams.data?.teams, props.data?.rows, bt.data) : null), [asked, week.data, teams.data, props.data, bt.data]);
  const run = React.useMemo(() => (week.data ? (text: string, onStatus: (s: string) => void) => import("@/lib/cfbAskAi")
    .then((m) => m.askCfbAi(ai.key, { week: week.data!, teams: teams.data?.teams ?? [], props: props.data?.rows ?? [], bt: bt.data }, text, [], onStatus)) : null),
  [week.data, teams.data, props.data, bt.data, ai.key]);
  const aiAns = useAiAnswer(asked, ai.on, run);
  if (week.isError) return <NotPublished error={week.error} />;
  return (
    <div className="space-y-5">
      <PageTitle kicker="College football" title="Ask" />
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask(q.trim()); }} className="flex gap-2">
        <div className="relative flex-1">
          <MessageCircleQuestion className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this week's games" className="pl-9" aria-label="Question" />
        </div>
        <AiToggle ai={ai} />
        <Button type="submit" variant="primary">Ask</Button>
      </form>
      <div className="-mt-3 text-right"><AiKeyLink ai={ai} /></div>
      {ai.showKey && <KeyPanel keyValue={ai.key} onSave={ai.save} />}
      <div className="flex flex-wrap gap-2">
        {suggestionsFor(week.data).map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">{s}</button>)}
      </div>
      {!week.data && <Card><LoadingBlock rows={4} className="p-5" /></Card>}
      {aiAns && <AiCard text={aiAns.text} status={aiAns.status} error={aiAns.error} />}
      {a && (!aiAns || aiAns.error) && (
        <Card>
          <CardHeader title={a.title} subtitle={a.text} />
          {!!a.sections?.length && <WriteUp sections={a.sections} />}
          <div className="divide-y divide-line/60">
            {a.leans.map(({ game, lean }) => (
              <LeanRow key={`${game.game_id}-${lean.market}-${lean.team ?? ""}`} m={lean} bt={bt.data} to={`/cfb/game/${game.game_id}`} sub={`${game.away} at ${game.home}`} />
            ))}
            {a.teams.map((t) => (
              <Link key={t.team_id} to={`/cfb/ask?q=${encodeURIComponent(t.team)}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-raised/50">
                <span className="w-6 text-muted tabular-nums">{t.power_rank}</span>
                <div className="min-w-0 flex-1"><div className="font-medium">{t.team}</div><div className="text-xs text-muted">{t.conference} · {t.w}-{t.l} · ATS {t.ats_w}-{t.ats_l} · O/U {t.over}-{t.under}</div></div>
                <div className="text-right"><b>{t.net != null ? `${t.net > 0 ? "+" : ""}${num(t.net, 1)}` : "–"}</b><div className="text-xs text-muted">net</div></div>
              </Link>
            ))}
            {a.props.map((r) => (
              <div key={`${r.player_id}-${r.market}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1"><Link to={`/cfb/players/${r.player_id}`} className="font-medium hover:text-accent">{r.player}</Link><div className="text-xs text-muted">{r.team} vs {r.opp} · projects {num(r.mean, 1)}</div></div>
                <div className="text-right"><div className="font-semibold">{r.side === "over" ? "Over" : "Under"} {r.line} {r.label.toLowerCase()}</div>
                  <div className="text-xs text-muted"><RatingMeter size="sm" score={r.score} p={r.p} fair={r.fair_p} ev={r.ev} proven={r.proven} /> · {r.line_source === "book" ? "book line" : "usual line"}</div></div>
              </div>
            ))}
            {!a.leans.length && !a.teams.length && !a.props.length && !a.text && <p className="p-4 text-sm text-muted">Nothing matches. Try one of the suggestions.</p>}
          </div>
          {!!a.suggestions?.length && (
            <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
              <span className="text-xs text-muted">Try:</span>
              {a.suggestions.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">{s}</button>)}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
