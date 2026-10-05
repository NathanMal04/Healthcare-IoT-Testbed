"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  TERMINAL_STATUSES,
  cancelRun,
  formatMoney,
  getJobLog,
  getRun,
  listRuns,
  type Run,
  type RunDetail,
} from "@/lib/runs";
import { formatBytes, getArtifactDownloadUrl, listArtifacts, type Artifact } from "@/lib/artifacts";
import NewRunForm from "@/app/components/NewRunForm";
import { useWorkspace } from "@/context/WorkspaceContext";
import {
  Alert,
  Button,
  PageHeader,
  StatusBadge,
  TextModal,
  cardClass,
  formatDate,
  primaryButton,
  secondaryButton,
  useRequireUser,
} from "@/app/components/ui";

const POLL_MS = 8000;

function RunView({ runId }: { runId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [outputs, setOutputs] = useState<Artifact[]>([]);
  const [outputsToken, setOutputsToken] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ title: string; text: string | null; loading: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, o] = await Promise.all([getRun(runId), listArtifacts({ runId, limit: 100 })]);
      setDetail(d);
      setOutputs(o.artifacts);
      setOutputsToken(o.nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the run");
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = detail ? !TERMINAL_STATUSES.includes(detail.run.status) : false;
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [active, detail, load]);

  async function showLog(index: number) {
    const title = `Job ${index} log`;
    setViewer({ title, text: null, loading: true });
    try {
      const log = await getJobLog(runId, index);
      setViewer({ title, text: log.lines.join("\n") || log.note || "", loading: false });
    } catch (err) {
      setViewer({ title, text: err instanceof Error ? err.message : "Failed to load", loading: false });
    }
  }

  async function cancel() {
    try {
      await cancelRun(runId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  async function moreOutputs() {
    const page = await listArtifacts({ runId, limit: 100, nextToken: outputsToken });
    setOutputs((cur) => [...cur, ...page.artifacts]);
    setOutputsToken(page.nextToken);
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!detail) return <p className="text-sm text-slate-400">Loading…</p>;
  const run = detail.run;
  const done = run.unitsSucceeded + run.unitsFailed;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/runs" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700">
            ← All runs
          </Link>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight mt-1 break-words">{run.name}</h1>
          <p className="text-slate-500 text-sm mt-1">
            {run.moduleName} v{run.moduleVersion} · {run.class} {run.size} · started {formatDate(run.startedAt ?? run.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={run.cancelRequested && active ? "cancelling" : run.status} />
          {active && !run.cancelRequested && (
            <button type="button" className={secondaryButton} onClick={() => void cancel()}>
              Cancel run
            </button>
          )}
          {run.status === "completed" && run.outputCount > 0 && (
            <button type="button" className={primaryButton} onClick={() => router.push(`/runs?fromRun=${run.runId}`)}>
              Run another script on these outputs
            </button>
          )}
        </div>
      </div>
      {run.statusReason && <p className="text-sm text-slate-600 bg-surface-muted px-3 py-2 rounded-lg">{run.statusReason}</p>}

      <div className="grid md:grid-cols-4 gap-4">
        {[
          ["Work units", `${done} / ${run.unitCount}`, `${run.unitsFailed} failed`],
          ["Jobs", `${detail.jobs.counts.succeeded ?? 0} / ${run.childCount}`, `${detail.jobs.counts.running ?? 0} running`],
          ["Outputs", String(run.outputCount), `from ${run.inputCount} input file(s)`],
          ["Cost so far", formatMoney(run.costProvisional), `max ${formatMoney(run.maxCost)}`],
        ].map(([label, value, sub]) => (
          <div key={label} className={`${cardClass} p-4`}>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</p>
            <p className="text-2xl font-semibold text-slate-900 mt-1 tabular-nums">{value}</p>
            <p className="text-xs text-slate-400">{sub}</p>
          </div>
        ))}
      </div>
      <div className="h-2 bg-surface-sunken rounded-full overflow-hidden">
        <div className="h-full bg-brand-600 transition-all" style={{ width: `${run.unitCount ? (done / run.unitCount) * 100 : 0}%` }} />
      </div>

      {detail.failedUnits.length > 0 && (
        <div className={`${cardClass} p-6`}>
          <h2 className="font-semibold text-slate-700 mb-3">Failed work units</h2>
          <ul className="space-y-3">
            {detail.failedUnits.map((u) => (
              <li key={u.unitId}>
                <p className="text-sm font-medium text-slate-700">{u.key}</p>
                <pre className="text-xs text-red-700 bg-red-50 rounded p-2 mt-1 whitespace-pre-wrap max-h-40 overflow-auto">{u.error}</pre>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={`${cardClass} overflow-hidden`}>
        <h2 className="font-semibold text-slate-700 px-6 py-4 border-b border-line">Outputs</h2>
        {outputs.length === 0 ? (
          <p className="px-6 py-6 text-sm text-slate-400">No outputs yet.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {outputs.map((a) => (
                <tr key={a.artifactId} className="border-b border-slate-50">
                  <td className="px-6 py-2 text-slate-700 break-all">{a.originalFilename}</td>
                  <td className="px-3 py-2 text-slate-500">{a.type}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{formatBytes(a.sizeBytes)}</td>
                  <td className="px-6 py-2 text-right">
                    {a.status === "ready" ? (
                      <button
                        type="button"
                        className="text-xs text-brand-600 font-medium"
                        onClick={async () => window.location.assign(await getArtifactDownloadUrl(a.artifactId))}
                      >
                        Download
                      </button>
                    ) : (
                      <StatusBadge status={a.status} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {outputsToken && (
          <div className="px-6 py-3 text-center">
            <button type="button" className="text-sm text-brand-600" onClick={() => void moreOutputs()}>
              Load more
            </button>
          </div>
        )}
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <h2 className="font-semibold text-slate-700 px-6 py-4 border-b border-line">Jobs</h2>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-muted">
              <tr className="text-left text-slate-400">
                <th className="px-6 py-2 font-medium text-xs uppercase">Job</th>
                <th className="px-3 py-2 font-medium text-xs uppercase">Status</th>
                <th className="px-3 py-2 font-medium text-xs uppercase">Units</th>
                <th className="px-3 py-2 font-medium text-xs uppercase">Attempts</th>
                <th className="px-3 py-2 font-medium text-xs uppercase">Finished</th>
                <th className="px-6 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {detail.jobs.items.map((j) => (
                <tr key={j.index} className="border-t border-slate-50">
                  <td className="px-6 py-2 text-slate-700">#{j.index}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={j.status} title={j.statusReason} />
                  </td>
                  <td className="px-3 py-2 text-slate-500">{j.units}</td>
                  <td className="px-3 py-2 text-slate-500">{j.attempts}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{formatDate(j.stoppedAt)}</td>
                  <td className="px-6 py-2 text-right">
                    {j.hasLog && (
                      <button type="button" className="text-xs text-brand-600" onClick={() => void showLog(j.index)}>
                        Log
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {viewer && <TextModal title={viewer.title} text={viewer.text} loading={viewer.loading} onClose={() => setViewer(null)} />}
    </div>
  );
}

function RunsContent() {
  const params = useSearchParams();
  const router = useRouter();
  const { scope } = useWorkspace();
  const runId = params.get("id");
  const prefill = {
    moduleId: params.get("module") ?? undefined,
    batchId: params.get("batch") ?? undefined,
    fromRunId: params.get("fromRun") ?? undefined,
    selection: params.get("selection") === "1",
  };
  const prefilled = Boolean(prefill.moduleId || prefill.batchId || prefill.fromRunId || prefill.selection);
  const [creating, setCreating] = useState(prefilled);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCreating(prefilled);
  }, [prefilled]);

  useEffect(() => {
    if (runId) return;
    listRuns()
      .then(setRuns)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load runs"));
  }, [runId]);

  if (runId) return <RunView runId={runId} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        description="Scripts running in bulk over your artifacts."
        actions={
          !creating && (
            <Button icon={Plus} onClick={() => setCreating(true)}>
              New run
            </Button>
          )
        }
      />

      {scope.kind === "workspace" && (
        <p className="text-sm bg-amber-50 text-amber-800 border border-amber-100 px-4 py-2.5 rounded-lg">
          Workspace analysis runs are not available yet. Runs here use your Personal files and devices, not{" "}
          {scope.name}&apos;s.
        </p>
      )}

      {creating && (
        <NewRunForm
          prefill={prefill}
          onCancel={() => {
            setCreating(false);
            if (prefilled) router.replace("/runs");
          }}
        />
      )}

      {error && <Alert tone="error">{error}</Alert>}
      <div className={`${cardClass} overflow-hidden`}>
        {runs === null ? (
          <p className="px-6 py-8 text-sm text-slate-400">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-400">No runs yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 bg-surface-muted/60 border-b border-line">
                <th className="px-6 py-3 font-medium text-xs uppercase">Run</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Status</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Units</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Cost</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} className="border-b border-slate-50 hover:bg-surface-muted/80 cursor-pointer" onClick={() => router.push(`/runs?id=${r.runId}`)}>
                  <td className="px-6 py-3">
                    <p className="font-medium text-slate-800">{r.name}</p>
                    <p className="text-xs text-slate-400">
                      {r.moduleName} v{r.moduleVersion} · {r.class} {r.size}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={r.status} title={r.statusReason} />
                  </td>
                  <td className="px-3 py-3 text-slate-500">
                    {r.unitsSucceeded + r.unitsFailed} / {r.unitCount}
                    {r.unitsFailed > 0 && <span className="text-red-600"> ({r.unitsFailed} failed)</span>}
                  </td>
                  <td className="px-3 py-3 text-slate-500">{formatMoney(r.costProvisional)}</td>
                  <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{formatDate(r.startedAt ?? r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function RunsPage() {
  const ready = useRequireUser();
  if (!ready) return null;
  // useSearchParams needs a Suspense boundary in a static export.
  return (
    <Suspense fallback={<p className="text-sm text-slate-400">Loading…</p>}>
      <RunsContent />
    </Suspense>
  );
}
