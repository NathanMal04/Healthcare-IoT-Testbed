"use client";

import { useEffect, useState } from "react";
import { getUsage, type Usage } from "@/lib/usage";
import { formatMoney } from "@/lib/runs";
import { cardClass, formatDate, inputClass, useRequireUser } from "@/app/components/ui";

const SOURCE_LABELS: Record<string, string> = { batch: "Runs", codebuild: "Builds", ecs: "Sessions", cur: "Adjustments" };

function recentPeriods(count: number): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

export default function UsagePage() {
  const ready = useRequireUser();
  const periods = recentPeriods(12);
  const [period, setPeriod] = useState(periods[0]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    setUsage(null);
    getUsage(period)
      .then(setUsage)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load usage"));
  }, [ready, period]);

  if (!ready) return null;
  const budget = usage?.budget;
  const usedPct = budget ? Math.min(100, ((budget.spent + budget.held) / budget.monthlyLimit) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Usage</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Provisional charges at list price. They are replaced by actual AWS cost at the end of each month.
          </p>
        </div>
        <select className={`${inputClass} w-40`} value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

      {budget && period === periods[0] && (
        <div className={`${cardClass} p-6 space-y-3`}>
          <div className="flex justify-between text-sm">
            <span className="text-slate-600">
              Spent {formatMoney(budget.spent)} · held for running jobs {formatMoney(budget.held)}
            </span>
            <span className="text-slate-500">
              {formatMoney(budget.available)} left of {formatMoney(budget.monthlyLimit)}
            </span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className={`h-full ${usedPct > 90 ? "bg-red-500" : "bg-blue-600"}`} style={{ width: `${usedPct}%` }} />
          </div>
          <p className="text-xs text-slate-400">
            Heavy (EC2) class: {budget.heavyEnabled ? "enabled" : "not enabled — ask an admin"}
          </p>
        </div>
      )}

      {usage && (
        <div className="grid md:grid-cols-4 gap-4">
          <div className={`${cardClass} p-4`}>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Total</p>
            <p className="text-2xl font-bold text-slate-800 mt-1">{formatMoney(usage.total)}</p>
          </div>
          {Object.entries(usage.totals).map(([source, amount]) => (
            <div key={source} className={`${cardClass} p-4`}>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{SOURCE_LABELS[source] ?? source}</p>
              <p className="text-2xl font-bold text-slate-800 mt-1">{formatMoney(amount)}</p>
            </div>
          ))}
        </div>
      )}

      <div className={`${cardClass} overflow-hidden`}>
        {usage === null ? (
          <p className="px-6 py-8 text-sm text-slate-400">Loading…</p>
        ) : usage.entries.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-400">No usage in {period}.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 bg-slate-50/60 border-b border-slate-100">
                <th className="px-6 py-3 font-medium text-xs uppercase">What</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Type</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Duration</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Amount</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {usage.entries.map((e, i) => (
                <tr key={i} className="border-b border-slate-50">
                  <td className="px-6 py-2 text-slate-700">{e.resource}</td>
                  <td className="px-3 py-2 text-slate-500">
                    {SOURCE_LABELS[e.source] ?? e.source}
                    {e.kind === "actual" && <span className="text-xs text-emerald-700"> · actual</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {e.seconds ? `${Math.round(e.seconds)} s` : e.minutes ? `${e.minutes} min` : "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{formatMoney(e.amount)}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{formatDate(e.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
