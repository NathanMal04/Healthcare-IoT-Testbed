"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  createModule,
  getBuildLog,
  getModule,
  getPackages,
  getSourceDownloadUrl,
  listEnvironments,
  listModules,
  uploadModuleVersion,
  type Environment,
  type Module,
  type ModuleVersion,
  type ScriptLevel,
  type SourceUploadStage,
} from "@/lib/builds";
import { formatBytes } from "@/lib/artifacts";
import {
  StatusBadge,
  TextModal,
  cardClass,
  formatDate,
  inputClass,
  labelClass,
  primaryButton,
  secondaryButton,
  useRequireUser,
} from "@/app/components/ui";

const POLL_MS = 10000;

const LEVEL_HELP: Record<ScriptLevel, string> = {
  L1: "A single .py file defining run(ctx). Declare pip packages in a PEP 723 `# /// script` block.",
  L2: "A .zip project with main.py (defining run(ctx)) and an optional requirements.txt.",
  L3: "A .zip with your own Dockerfile and a platform.json naming the command to run per work unit.",
};

const STAGE_LABELS: Record<SourceUploadStage, string> = {
  hashing: "Hashing…",
  reserving: "Reserving…",
  uploading: "Uploading…",
  validating: "Checking and starting the build…",
};

function UploadVersion({
  module,
  environments,
  onDone,
}: {
  module: Module;
  environments: Environment[];
  onDone: () => void;
}) {
  const [level, setLevel] = useState<ScriptLevel>("L1");
  const [envId, setEnvId] = useState("platform-base");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<SourceUploadStage | null>(null);
  const [result, setResult] = useState<ModuleVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cloud = module.runtime === "cloud";
  const readyEnvs = environments.filter((e) => e.latestReadyVersion);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const version = await uploadModuleVersion(
        module.moduleId,
        file,
        cloud ? { level, envId: level === "L3" ? undefined : envId } : {},
        setStage
      );
      setResult(version);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setStage(null);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-slate-100 pt-4">
      <h3 className="text-sm font-semibold text-slate-600">Upload a new version</h3>
      {cloud && (
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Level</label>
            <select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value as ScriptLevel)}>
              <option value="L1">L1 · single .py</option>
              <option value="L2">L2 · .zip project</option>
              <option value="L3">L3 · .zip with Dockerfile</option>
            </select>
            <p className="text-xs text-slate-400 mt-1">{LEVEL_HELP[level]}</p>
          </div>
          {level !== "L3" && (
            <div>
              <label className={labelClass}>Environment</label>
              <select className={inputClass} value={envId} onChange={(e) => setEnvId(e.target.value)}>
                {readyEnvs.map((env) => (
                  <option key={env.envId} value={env.envId}>
                    {env.name} (v{env.latestReadyVersion})
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-400 mt-1">The tools installed in the script&apos;s container.</p>
            </div>
          )}
        </div>
      )}
      <input
        type="file"
        accept={!cloud ? undefined : level === "L1" ? ".py" : ".zip"}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-sm text-slate-600"
      />
      {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
      {result && (
        <p className={`text-xs px-3 py-2 rounded-lg ${result.status === "rejected" ? "text-red-600 bg-red-50" : "text-emerald-700 bg-emerald-50"}`}>
          v{result.version}: {result.status === "rejected" ? `rejected — ${result.statusReason}` : result.status === "building" ? "building (a few minutes)" : result.status}
        </p>
      )}
      <button type="submit" className={primaryButton} disabled={!file || stage !== null}>
        {stage ? STAGE_LABELS[stage] : "Upload"}
      </button>
    </form>
  );
}

export default function ScriptsPage() {
  const ready = useRequireUser();
  const [modules, setModules] = useState<Module[] | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState<"cloud" | "local">("cloud");
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ module: Module; versions: ModuleVersion[] } | null>(null);
  const [viewer, setViewer] = useState<{ title: string; text: string | null; loading: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setModules(await listModules());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scripts");
    }
  }, []);

  const loadDetail = useCallback(async (moduleId: string) => {
    try {
      setDetail(await getModule(moduleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the script");
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void load();
    listEnvironments().then(setEnvironments).catch(() => setEnvironments([]));
  }, [ready, load]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  const building = detail?.versions.some((v) => v.status === "building") ?? false;
  useEffect(() => {
    if (!building || !selected) return;
    const timer = setTimeout(() => void loadDetail(selected), POLL_MS);
    return () => clearTimeout(timer);
  }, [building, selected, detail, loadDetail]);

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createModule({ name: name.trim(), description: description.trim(), runtime });
      setCreating(false);
      setName("");
      setDescription("");
      await load();
      setSelected(created.moduleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the script");
    } finally {
      setBusy(false);
    }
  }

  async function show(kind: "log" | "packages", version: ModuleVersion) {
    const title = kind === "log" ? `Build log · v${version.version}` : `Installed packages · v${version.version}`;
    setViewer({ title, text: null, loading: true });
    try {
      if (kind === "log") {
        const log = await getBuildLog("modules", version.moduleId, version.version);
        setViewer({ title, text: log.lines.join("\n") || log.note || "", loading: false });
      } else {
        const packages = await getPackages("modules", version.moduleId, version.version);
        setViewer({
          title,
          text: `# Python (pip freeze)\n${packages.pip ?? "(not recorded)"}\n\n# System (dpkg)\n${packages.dpkg ?? "(not recorded)"}`,
          loading: false,
        });
      }
    } catch (err) {
      setViewer({ title, text: err instanceof Error ? err.message : "Failed to load", loading: false });
    }
  }

  async function download(version: ModuleVersion) {
    try {
      window.location.assign(await getSourceDownloadUrl(version.moduleId, version.version));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    }
  }

  if (!ready) return null;
  const envName = (id?: string) => environments.find((e) => e.envId === id)?.name ?? id ?? "—";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Scripts</h1>
          <p className="text-slate-400 mt-1 text-sm">Upload analysis scripts and run them in bulk over your artifacts.</p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className={primaryButton}>
          + New script
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

      {creating && (
        <form onSubmit={submitCreate} className={`${cardClass} p-6 space-y-4`}>
          <h2 className="font-semibold text-slate-700">New script</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Name</label>
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pair checker" />
            </div>
            <div>
              <label className={labelClass}>Runs</label>
              <select className={inputClass} value={runtime} onChange={(e) => setRuntime(e.target.value as "cloud" | "local")}>
                <option value="cloud">In the cloud (built and run in bulk)</option>
                <option value="local">Locally (stored and versioned only)</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" className={secondaryButton} onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={primaryButton} disabled={busy || !name.trim()}>
              Create
            </button>
          </div>
        </form>
      )}

      <div className={`${cardClass} overflow-hidden`}>
        {modules === null ? (
          <p className="px-6 py-8 text-sm text-slate-400">Loading…</p>
        ) : modules.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-400">No scripts yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 bg-slate-50/60 border-b border-slate-100">
                <th className="px-6 py-3 font-medium text-xs uppercase">Name</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Runs</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Latest ready</th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => (
                <tr
                  key={m.moduleId}
                  onClick={() => setSelected(m.moduleId)}
                  className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50/80 ${selected === m.moduleId ? "bg-blue-50/50" : ""}`}
                >
                  <td className="px-6 py-3 font-medium text-slate-800">{m.name}</td>
                  <td className="px-3 py-3 text-slate-500">{m.runtime}</td>
                  <td className="px-3 py-3 text-slate-500">{m.latestReadyVersion ? `v${m.latestReadyVersion}` : "—"}</td>
                  <td className="px-6 py-3 text-right">
                    {m.runtime === "cloud" && m.latestReadyVersion && (
                      <Link
                        href={`/runs?module=${m.moduleId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs text-blue-600 font-medium"
                      >
                        Run
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <div className={`${cardClass} p-6 space-y-5`}>
          <div>
            <h2 className="font-semibold text-slate-700">{detail.module.name}</h2>
            {detail.module.description && <p className="text-sm text-slate-500 mt-1">{detail.module.description}</p>}
          </div>
          {detail.versions.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-100">
                  <th className="py-2 font-medium text-xs uppercase">Version</th>
                  <th className="py-2 font-medium text-xs uppercase">Level</th>
                  <th className="py-2 font-medium text-xs uppercase">Environment</th>
                  <th className="py-2 font-medium text-xs uppercase">Status</th>
                  <th className="py-2 font-medium text-xs uppercase">File</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((v) => (
                  <tr key={v.version} className="border-b border-slate-50 align-top">
                    <td className="py-2 font-medium text-slate-700">
                      v{v.version}
                      <span className="block text-xs text-slate-400">{formatDate(v.createdAt)}</span>
                    </td>
                    <td className="py-2 text-slate-500">{v.level ?? "local"}</td>
                    <td className="py-2 text-slate-500">{v.level === "L3" ? "own Dockerfile" : v.envId ? `${envName(v.envId)} v${v.envVersion}` : "—"}</td>
                    <td className="py-2">
                      <StatusBadge status={v.status} />
                      {v.statusReason && <p className="text-xs text-red-600 mt-1 max-w-sm whitespace-pre-wrap">{v.statusReason}</p>}
                    </td>
                    <td className="py-2 text-slate-500">
                      {v.originalFilename}
                      <span className="block text-xs text-slate-400">{formatBytes(v.sizeBytes)}</span>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap space-x-3">
                      <button type="button" className="text-xs text-blue-600" onClick={() => void download(v)}>
                        Source
                      </button>
                      {v.runtime === "cloud" && v.status !== "rejected" && (
                        <button type="button" className="text-xs text-blue-600" onClick={() => void show("log", v)}>
                          Log
                        </button>
                      )}
                      {v.status === "ready" && v.runtime === "cloud" && (
                        <button type="button" className="text-xs text-blue-600" onClick={() => void show("packages", v)}>
                          Packages
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <UploadVersion module={detail.module} environments={environments} onDone={() => void loadDetail(detail.module.moduleId)} />
        </div>
      )}

      {viewer && <TextModal title={viewer.title} text={viewer.text} loading={viewer.loading} onClose={() => setViewer(null)} />}
    </div>
  );
}
