"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getModule, listModules, type Module, type ModuleVersion } from "@/lib/builds";
import { ARTIFACT_TYPES, formatBytes, listUploadBatches, type ArtifactType, type UploadBatch } from "@/lib/artifacts";
import { getDevices, type Device } from "@/lib/devices";
import {
  RUN_SELECTION_KEY,
  estimateRun,
  formatMoney,
  listRuns,
  startRun,
  type Estimate,
  type GroupBy,
  type Run,
  type RunClass,
  type RunInputs,
  type RunMode,
  type RunRequest,
  type RunSize,
} from "@/lib/runs";
import { cardClass, formatDate, inputClass, labelClass, primaryButton, secondaryButton } from "@/app/components/ui";

type Source = "batch" | "device" | "filter" | "selection" | "run";

export interface NewRunPrefill {
  moduleId?: string;
  batchId?: string;
  fromRunId?: string;
  selection?: boolean;
}

const SIZE_LABELS: Record<RunSize, string> = {
  S: "S · 1 vCPU, 2 GB",
  M: "M · 2 vCPU, 8 GB",
  L: "L · 4 vCPU, 16 GB",
  XL: "XL · 8 vCPU, 32 GB",
};

export default function NewRunForm({ prefill, onCancel }: { prefill: NewRunPrefill; onCancel: () => void }) {
  const router = useRouter();
  const [modules, setModules] = useState<Module[]>([]);
  const [versions, setVersions] = useState<ModuleVersion[]>([]);
  const [batches, setBatches] = useState<UploadBatch[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selection] = useState<string[]>(() => {
    try {
      return prefill.selection ? JSON.parse(sessionStorage.getItem(RUN_SELECTION_KEY) || "[]") : [];
    } catch {
      return [];
    }
  });

  const [moduleId, setModuleId] = useState(prefill.moduleId ?? "");
  const [version, setVersion] = useState<number | "">("");
  const [source, setSource] = useState<Source>(
    prefill.selection ? "selection" : prefill.fromRunId ? "run" : prefill.batchId ? "batch" : "batch"
  );
  const [batchId, setBatchId] = useState(prefill.batchId ?? "");
  const [deviceId, setDeviceId] = useState("");
  const [runId, setRunId] = useState(prefill.fromRunId ?? "");
  const [type, setType] = useState<ArtifactType | "">("");
  const [tag, setTag] = useState("");

  const [mode, setMode] = useState<RunMode>("map");
  const [groupBy, setGroupBy] = useState<GroupBy>("stem");
  const [depth, setDepth] = useState(0);
  const [pattern, setPattern] = useState("");
  const [tagPrefix, setTagPrefix] = useState("pair:");
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [requireTypes, setRequireTypes] = useState<ArtifactType[]>([]);
  const [includeIncomplete, setIncludeIncomplete] = useState(false);
  const [chunkSize, setChunkSize] = useState(10);
  const [unitsPerJob, setUnitsPerJob] = useState(1);

  const [runClass, setRunClass] = useState<RunClass>("economy");
  const [size, setSize] = useState<RunSize>("S");
  const [timeout, setTimeoutMinutes] = useState(30);
  const [name, setName] = useState("");

  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    listModules().then((all) => setModules(all.filter((m) => m.runtime === "cloud" && m.latestReadyVersion))).catch(() => {});
    listUploadBatches().then(setBatches).catch(() => {});
    getDevices().then(setDevices).catch(() => {});
    listRuns().then((all) => setRuns(all.filter((r) => r.status === "completed" && r.outputCount > 0))).catch(() => {});
  }, []);

  useEffect(() => {
    setVersions([]);
    setVersion("");
    if (!moduleId) return;
    getModule(moduleId)
      .then((m) => setVersions(m.versions.filter((v) => v.status === "ready")))
      .catch(() => setVersions([]));
  }, [moduleId]);

  const request: RunRequest | null = useMemo(() => {
    if (!moduleId) return null;
    let inputs: RunInputs;
    if (source === "batch") {
      if (!batchId) return null;
      inputs = { batchId };
    } else if (source === "device") {
      if (!deviceId) return null;
      inputs = { deviceId, ...(type ? { type } : {}) };
    } else if (source === "run") {
      if (!runId) return null;
      inputs = { runId };
    } else if (source === "selection") {
      if (!selection.length) return null;
      inputs = { artifactIds: selection };
    } else {
      inputs = { ...(type ? { type } : {}), ...(tag.trim() ? { tag: tag.trim() } : {}) };
    }
    return {
      moduleId,
      ...(version ? { version } : {}),
      inputs,
      mode,
      ...(mode === "chunk" ? { chunkSize } : {}),
      ...(mode === "groupBy"
        ? {
            groupBy: {
              by: groupBy,
              ...(groupBy === "folder" ? { depth } : {}),
              ...(groupBy === "stem" ? { ignoreCase } : {}),
              ...(groupBy === "regex" ? { pattern } : {}),
              ...(groupBy === "tag" ? { tagPrefix } : {}),
              requireTypes,
              includeIncomplete,
            },
          }
        : {}),
      unitsPerJob,
      class: runClass,
      size,
      timeoutMinutes: timeout,
      ...(name.trim() ? { name: name.trim() } : {}),
    };
  }, [moduleId, version, source, batchId, deviceId, runId, selection, type, tag, mode, chunkSize, groupBy, depth,
    ignoreCase, pattern, tagPrefix, requireTypes, includeIncomplete, unitsPerJob, runClass, size, timeout, name]);

  // Re-estimate shortly after the form stops changing.
  useEffect(() => {
    setEstimate(null);
    setError(null);
    if (!request || (mode === "groupBy" && groupBy === "regex" && !pattern)) return;
    const timer = setTimeout(async () => {
      setEstimating(true);
      try {
        setEstimate(await estimateRun(request));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Estimate failed");
      } finally {
        setEstimating(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [request, mode, groupBy, pattern]);

  async function start() {
    if (!request) return;
    setStarting(true);
    setError(null);
    try {
      const run = await startRun(request);
      try {
        sessionStorage.removeItem(RUN_SELECTION_KEY);
      } catch {
        // storage unavailable; nothing to clean up
      }
      router.push(`/runs?id=${run.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the run");
      setStarting(false);
    }
  }

  const tooExpensive = estimate ? estimate.maxCost > estimate.budget.available : false;

  return (
    <div className={`${cardClass} p-6 space-y-6`}>
      <h2 className="font-semibold text-slate-700">New run</h2>

      <section className="grid md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <label className={labelClass}>Script</label>
          <select className={inputClass} value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
            <option value="">Choose a script…</option>
            {modules.map((m) => (
              <option key={m.moduleId} value={m.moduleId}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Version</label>
          <select className={inputClass} value={version} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Latest ready</option>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} ({v.level})
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="space-y-3">
        <label className={labelClass}>Inputs</label>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["batch", "Upload batch"],
              ["device", "Device"],
              ["filter", "Type / tag"],
              ["selection", `Selected files${selection.length ? ` (${selection.length})` : ""}`],
              ["run", "Outputs of a run"],
            ] as [Source, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSource(value)}
              className={`text-sm px-3 py-1.5 rounded-lg border ${source === value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {source === "batch" && (
          <select className={inputClass} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">Choose an upload…</option>
            {batches.map((b) => (
              <option key={b.uploadBatchId} value={b.uploadBatchId}>
                {formatDate(b.createdAt)} · {b.fileCount} files · {formatBytes(b.totalBytes)}
              </option>
            ))}
          </select>
        )}
        {source === "device" && (
          <div className="grid md:grid-cols-2 gap-3">
            <select className={inputClass} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Choose a device…</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.name}
                </option>
              ))}
            </select>
            <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as ArtifactType | "")}>
              <option value="">All types</option>
              {ARTIFACT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}
        {source === "filter" && (
          <div className="grid md:grid-cols-2 gap-3">
            <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as ArtifactType | "")}>
              <option value="">All types</option>
              {ARTIFACT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input className={inputClass} placeholder="Tag (optional)" value={tag} onChange={(e) => setTag(e.target.value)} />
          </div>
        )}
        {source === "selection" && (
          <p className="text-sm text-slate-500">
            {selection.length
              ? `${selection.length} file(s) picked on the Artifacts page.`
              : "Tick files on the Artifacts page and choose “Run a script on selected”."}
          </p>
        )}
        {source === "run" && (
          <select className={inputClass} value={runId} onChange={(e) => setRunId(e.target.value)}>
            <option value="">Choose a finished run…</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.name} · {r.outputCount} outputs · {formatDate(r.createdAt)}
              </option>
            ))}
          </select>
        )}
      </section>

      <section className="space-y-3">
        <label className={labelClass}>How files are processed</label>
        <div className="grid md:grid-cols-4 gap-2">
          {(
            [
              ["map", "One file at a time"],
              ["groupBy", "Files that belong together"],
              ["chunk", "Fixed-size batches"],
              ["all", "All files at once"],
            ] as [RunMode, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`text-sm px-3 py-2 rounded-lg border text-left ${mode === value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "groupBy" && (
          <div className="space-y-3 border border-slate-100 rounded-lg p-4">
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Group by</label>
                <select className={inputClass} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                  <option value="stem">File name (test-017.log + test-017.pcap)</option>
                  <option value="folder">Folder (test-017/app.log + test-017/net.pcap)</option>
                  <option value="regex">Pattern (an ID captured from the path)</option>
                  <option value="tag">Tag (pair:017 on both files)</option>
                </select>
              </div>
              {groupBy === "folder" && (
                <div>
                  <label className={labelClass}>Folder level</label>
                  <select className={inputClass} value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                    <option value={0}>The file&apos;s own folder</option>
                    <option value={1}>Top-level folder</option>
                    <option value={2}>Second level</option>
                  </select>
                </div>
              )}
              {groupBy === "stem" && (
                <label className="flex items-center gap-2 text-sm text-slate-600 mt-6">
                  <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} /> Ignore upper/lower case
                </label>
              )}
              {groupBy === "regex" && (
                <div>
                  <label className={labelClass}>Pattern</label>
                  <input className={inputClass} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="(\d+)" />
                </div>
              )}
              {groupBy === "tag" && (
                <div>
                  <label className={labelClass}>Tag prefix</label>
                  <input className={inputClass} value={tagPrefix} onChange={(e) => setTagPrefix(e.target.value)} />
                </div>
              )}
            </div>
            <div>
              <label className={labelClass}>Each group must contain</label>
              <div className="flex flex-wrap gap-3">
                {ARTIFACT_TYPES.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={requireTypes.includes(t)}
                      onChange={() => setRequireTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
                    />
                    {t}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600 mt-2">
                <input type="checkbox" checked={includeIncomplete} onChange={(e) => setIncludeIncomplete(e.target.checked)} />
                Also run incomplete groups
              </label>
            </div>
          </div>
        )}

        {mode === "chunk" && (
          <div className="max-w-xs">
            <label className={labelClass}>Files per batch</label>
            <input type="number" min={1} className={inputClass} value={chunkSize} onChange={(e) => setChunkSize(Math.max(1, Number(e.target.value)))} />
          </div>
        )}
        {mode !== "all" && (
          <div className="max-w-xs">
            <label className={labelClass}>Work units per job</label>
            <input type="number" min={1} max={1000} className={inputClass} value={unitsPerJob} onChange={(e) => setUnitsPerJob(Math.max(1, Number(e.target.value)))} />
            <p className="text-xs text-slate-400 mt-1">Higher is cheaper for many tiny units; 1 runs them all in parallel.</p>
          </div>
        )}
      </section>

      <section className="grid md:grid-cols-4 gap-4">
        <div>
          <label className={labelClass}>Class</label>
          <select className={inputClass} value={runClass} onChange={(e) => setRunClass(e.target.value as RunClass)}>
            <option value="economy">Economy (Spot, cheapest)</option>
            <option value="standard">Standard (on-demand)</option>
            <option value="heavy">Heavy (dedicated EC2)</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Size</label>
          <select className={inputClass} value={size} onChange={(e) => setSize(e.target.value as RunSize)}>
            {(Object.keys(SIZE_LABELS) as RunSize[]).map((s) => (
              <option key={s} value={s}>
                {runClass === "heavy" ? s : SIZE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Timeout per job (min)</label>
          <input type="number" min={1} max={360} className={inputClass} value={timeout} onChange={(e) => setTimeoutMinutes(Math.min(360, Math.max(1, Number(e.target.value))))} />
        </div>
        <div>
          <label className={labelClass}>Run name (optional)</label>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </section>

      <section className="bg-slate-50 rounded-lg p-4 text-sm space-y-2">
        {estimating && <p className="text-slate-400">Estimating…</p>}
        {error && <p className="text-red-600">{error}</p>}
        {!estimating && !error && !estimate && <p className="text-slate-400">Choose a script and inputs to see a preview.</p>}
        {estimate && (
          <>
            <p className="text-slate-700">
              <strong>{estimate.inputCount}</strong> file(s), {formatBytes(estimate.totalBytes)} →{" "}
              <strong>{estimate.unitCount}</strong> work unit(s) in <strong>{estimate.childCount}</strong> job(s) (v{estimate.version})
            </p>
            {estimate.notReadyCount > 0 && (
              <p className="text-amber-700">{estimate.notReadyCount} matched file(s) aren&apos;t ready yet and will be left out.</p>
            )}
            {estimate.incompleteCount > 0 && (
              <details className="text-amber-700">
                <summary>
                  {estimate.incompleteCount} incomplete group(s) {includeIncomplete ? "(included)" : "(skipped)"}
                </summary>
                <ul className="mt-1 ml-4 list-disc text-xs">
                  {estimate.incomplete.map((g) => (
                    <li key={g.key}>
                      {g.key}: missing {g.missing.join(", ")} ({g.files.join(", ")})
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {estimate.unmatchedCount > 0 && (
              <details className="text-amber-700">
                <summary>{estimate.unmatchedCount} file(s) have no group key and are left out</summary>
                <ul className="mt-1 ml-4 list-disc text-xs">
                  {estimate.unmatched.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </details>
            )}
            {estimate.sampleUnits.length > 0 && mode !== "map" && (
              <p className="text-xs text-slate-500">
                e.g. {estimate.sampleUnits.slice(0, 4).map((u) => `${u.key} (${u.files})`).join(", ")}
              </p>
            )}
            <p className="text-slate-700">
              Expected cost: <strong>{estimate.expectedCost === null ? "no history yet" : formatMoney(estimate.expectedCost)}</strong> ·
              maximum <strong>{formatMoney(estimate.maxCost)}</strong> (held from your budget until the run ends)
            </p>
            <p className={tooExpensive ? "text-red-600" : "text-slate-500"}>
              Budget available this month: {formatMoney(estimate.budget.available)} of {formatMoney(estimate.budget.monthlyLimit)}
              {tooExpensive && " — lower the timeout, size or number of jobs"}
            </p>
          </>
        )}
      </section>

      <div className="flex justify-end gap-3">
        <button type="button" className={secondaryButton} onClick={onCancel} disabled={starting}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={!estimate || estimate.unitCount === 0 || tooExpensive || starting}
          onClick={() => void start()}
        >
          {starting ? "Starting…" : "Start run"}
        </button>
      </div>
    </div>
  );
}
