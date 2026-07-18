import React from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, CircleCheck, CircleAlert, CircleX } from 'lucide-react';
import type { ValidationReport } from '../lib/api';

// Carte de restitution d'un rapport AQM (verdict + score + détail des contrôles).
// Partagée par la saisie d'écriture et la facturation.
export default function AqmReportCard({ report }: { report: ValidationReport }) {
  const tone = report.verdict === 'PASS' ? 'emerald' : report.verdict === 'WARNING' ? 'amber' : 'rose';
  const Icon = report.verdict === 'PASS' ? ShieldCheck : report.verdict === 'WARNING' ? ShieldAlert : ShieldX;
  const label = report.verdict === 'PASS' ? 'Conforme' : report.verdict === 'WARNING' ? 'Points de vigilance' : 'Bloquant';
  const border = tone === 'emerald' ? 'border-emerald-500/30 bg-emerald-500/[0.07]' : tone === 'amber' ? 'border-amber-500/30 bg-amber-500/[0.07]' : 'border-rose-500/30 bg-rose-500/[0.07]';
  const txt = tone === 'emerald' ? 'text-emerald-400' : tone === 'amber' ? 'text-amber-400' : 'text-rose-400';
  const lvlIcon = (lvl: string) => lvl === 'pass' ? <CircleCheck className="h-4 w-4 text-emerald-400" /> : lvl === 'warning' ? <CircleAlert className="h-4 w-4 text-amber-400" /> : <CircleX className="h-4 w-4 text-rose-400" />;
  return (
    <div className={`rounded-xl border p-4 ${border}`}>
      <div className="flex items-center justify-between gap-3">
        <span className={`flex items-center gap-2 text-sm font-semibold ${txt}`}><Icon className="h-5 w-5" /> AQM · {label}</span>
        <span className="font-mono text-sm text-zinc-300">score <b className={txt}>{report.score}</b>/100</span>
      </div>
      <p className="mt-1.5 text-sm text-zinc-400">{report.summary}</p>
      <ul className="mt-3 space-y-1.5">
        {report.checks.map((k) => (
          <li key={k.code} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5">{lvlIcon(k.level)}</span>
            <span className={k.level === 'pass' ? 'text-zinc-400' : 'text-zinc-200'}>
              <b className="font-medium">{k.label}</b>{k.detail ? <> — <span className="text-zinc-400">{k.detail}</span></> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
