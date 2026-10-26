"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FileCode, Plus, Square } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ACTIVE_SESSION_STATUSES,
  NOTEBOOK_SELECTION_KEY,
  getSession,
  getSessionLog,
  listSessionNotebooks,
  listSessions,
  readSessionNotebook,
  sessionCostSoFar,
  startSession,
  stopSession,
  type NotebookFile,
  type Session,
  type SessionDetail,
  type SessionList,
  type SessionSize,
} from "@/lib/sessions";
import { createModule, listEnvironments, listModules, uploadModuleVersion, type Environment, type Module } from "@/lib/builds";
import { formatBytes, listArtifacts, type Artifact } from "@/lib/artifacts";
import { formatMoney, parseRunSelection } from "@/lib/runs";
import { notebookToScript } from "@/lib/notebookScript";
import { useWorkspace } from "@/context/WorkspaceContext";
import { scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import {
  Alert,
  Button,
  Dialog,
  LoadingState,
  PageHeader,
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

const POLL_MS = 5000;
const SLOW_POLL_MS = 30000;

function statusNote(detail: SessionDetail): string | null {
  const { session, network } = detail;
  if (session.status === "waiting") {
    return network === "up"
      ? "Starting…"
      : "Starting the private network. Notebooks open about 2–3 minutes after a quiet period.";
  }
  if (session.status === "launching") return "Starting the notebook container. This usually takes 1–2 minutes.";
  if (session.status === "running" && !session.ready) return "Starting JupyterLab…";
  if (session.status === "stopping") return "Saving your notebooks and stopping…";
  return null;
}

// --- Save as script ---------------------------------------------------------------------

function SaveAsScript({ detail, onClose }: { detail: SessionDetail; onClose: () => void }) {
  const session = detail.session;
  const [notebooks, setNotebooks] = useState<NotebookFile[] | null>(null);
  const [modules, setModules] = useState<Module[]>([]);
  const [path, setPath] = useState("");
  const [target, setTarget] = useState("new");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ moduleId: string; version: number } | null>(null);

  useEffect(() => {
    if (!detail.token) return;
    listSessionNotebooks(session.sessionId, detail.token)
      .then((found) => {
        setNotebooks(found);
        if (found.length) {
          setPath(found[0].path);
          setName(found[0].name.replace(/\.ipynb$/, ""));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't list notebooks"));
    listModules()
      .then((all) => setModules(all.filter((m) => m.runtime === "cloud")))
      .catch(() => setModules([]));
  }, [detail.token, session.sessionId]);

  async function save() {
    if (!detail.token || !path) return;
    setBusy(true);
    setError(null);
    try {
      const notebook = await readSessionNotebook(session.sessionId, detail.token, path);
      const title = path.split("/").pop() ?? path;
      const source = notebookToScript(notebook, title);
      const fileName = `${(target === "new" ? name : title.replace(/\.ipynb$/, "")).trim().replace(/[^\w.-]+/g, "_") || "notebook"}.py`;
      const moduleId =
        target === "new"
          ? (await createModule({ name: name.trim(), runtime: "cloud", description: `Saved from the notebook ${title}` })).moduleId
          : target;
      const version = await uploadModuleVersion(moduleId, new File([source], fileName, { type: "text/x-python" }), {
        level: "L1",
        envId: session.envId,
        envVersion: session.envVersion,
      });
      setDone({ moduleId, version: version.version });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saving failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Save as script" subtitle="A notebook becomes an L1 script on this session's environment." onClose={onClose}>
      <div className="space-y-4">
        {done ? (
          <Alert tone="success">
            Saved as version {done.version}; it&apos;s building now.{" "}
            <Link href="/scripts" className="font-medium underline">
              Open Scripts
            </Link>
          </Alert>
        ) : notebooks === null ? (
          <p className="text-sm text-slate-400">{error ?? "Looking for notebooks…"}</p>
        ) : notebooks.length === 0 ? (
          <p className="text-sm text-slate-500">There are no notebooks in /work/notebooks yet.</p>
        ) : (
          <>
            <div>
              <label className={labelClass}>Notebook</label>
              <select className={inputClass} value={path} onChange={(e) => setPath(e.target.value)} disabled={busy}>
                {notebooks.map((n) => (
                  <option key={n.path} value={n.path}>
                    {n.path.replace(/^notebooks\//, "")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Save to</label>
              <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
                <option value="new">A new script</option>
                {modules.map((m) => (
                  <option key={m.moduleId} value={m.moduleId}>
                    New version of {m.name}
                  </option>
                ))}
              </select>
            </div>
            {target === "new" && (
              <div>
                <label className={labelClass}>Script name</label>
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
              </div>
            )}
            <p className="text-xs text-slate-500">
              Code cells are wrapped in <code>run(ctx)</code> (unless the notebook already defines it), the{" "}
              <code>context()</code> lines are dropped, and <code>%</code>/<code>!</code> lines are commented out. Save the
              notebook in JupyterLab first.
            </p>
            {error && <Alert tone="error">{error}</Alert>}
            <div className="flex justify-end gap-3">
              <button type="button" className={secondaryButton} onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={busy || !path || (target === "new" && !name.trim())}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save and build"}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// --- One session ------------------------------------------------------------------------------

function SessionView({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [hourly, setHourly] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewer, setViewer] = useState<{ text: string | null; loading: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setDetail(await getSession(sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the session");
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detail) return;
    listSessions()
      .then((list) => setHourly(list.sizes[detail.session.size]?.hourly ?? 0))
      .catch(() => undefined);
    // Only the size matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.session.size]);

  const active = detail ? ACTIVE_SESSION_STATUSES.includes(detail.session.status) : false;
  const opening = active && !detail?.url;
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void load(), opening ? POLL_MS : SLOW_POLL_MS);
    return () => clearTimeout(timer);
  }, [active, opening, detail, load]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [active]);

  async function stop() {
    try {
      await stopSession(sessionId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stop failed");
    }
  }

  async function showLog() {
    setViewer({ text: null, loading: true });
    try {
      const log = await getSessionLog(sessionId);
      setViewer({ text: log.lines.join("\n") || log.note || "", loading: false });
    } catch (err) {
      setViewer({ text: err instanceof Error ? err.message : "Failed to load", loading: false });
    }
  }

  if (error && !detail) return <Alert tone="error">{error}</Alert>;
  if (!detail) return <p className="text-sm text-slate-400">Loading…</p>;
  const session = detail.session;
  const note = statusNote(detail);
  const started = session.startedAt ? Date.parse(session.startedAt) : null;
  const left = started ? Math.max(0, started + session.maxSeconds * 1000 - now) : session.maxSeconds * 1000;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/notebooks" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700">
            ← All notebooks
          </Link>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight mt-1 break-words">{session.name}</h1>
          <p className="text-slate-500 text-sm mt-1">
            {session.envName} v{session.envVersion} · size {session.size} · {session.inputCount} file(s) ·{" "}
            {active ? (
              <>
                {formatMoney(sessionCostSoFar(session, hourly, now))} so far · {Math.round(left / 60000)} min left
              </>
            ) : (
              <>cost {formatMoney(session.costProvisional)}</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={session.status} title={session.statusReason} />
          {detail.url && (
            <>
              <Button size="sm" variant="secondary" icon={FileCode} onClick={() => setSaving(true)}>
                Save as script
              </Button>
              <a href={detail.url} target="_blank" rel="noreferrer" className={secondaryButton}>
                <ExternalLink className="w-4 h-4 inline mr-1" aria-hidden />
                New tab
              </a>
            </>
          )}
          {session.launchedAt && (
            <button type="button" className="text-xs text-brand-600" onClick={() => void showLog()}>
              Log
            </button>
          )}
          {active && session.status !== "stopping" && (
            <Button size="sm" variant="danger" icon={Square} onClick={() => void stop()}>
              Stop
            </Button>
          )}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {note && <Alert tone="info">{note}</Alert>}
      {!active && session.statusReason && (
        <p className="text-sm text-slate-600 bg-surface-muted px-3 py-2 rounded-lg">{session.statusReason}</p>
      )}

      {detail.url && session.status === "running" && (
        <iframe
          title={`JupyterLab: ${session.name}`}
          src={detail.url}
          className={`${cardClass} w-full`}
          style={{ height: "calc(100vh - 220px)", minHeight: 480 }}
        />
      )}

      {saving && <SaveAsScript detail={detail} onClose={() => setSaving(false)} />}
      {viewer && <TextModal title="Session log" text={viewer.text} loading={viewer.loading} onClose={() => setViewer(null)} />}
    </div>
  );
}

// --- New session -----------------------------------------------------------------------------

function NewSessionForm({
  list,
  prefill,
  onCancel,
}: {
  list: SessionList;
  prefill: { envId?: string; selection: boolean };
  onCancel: () => void;
}) {
  const router = useRouter();
  const { scope } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [envId, setEnvId] = useState(prefill.envId ?? "platform-base");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<string[]>(() => {
    if (!prefill.selection) return [];
    try {
      return parseRunSelection(sessionStorage.getItem(NOTEBOOK_SELECTION_KEY), scopeKey(scope));
    } catch {
      return [];
    }
  });
  const [search, setSearch] = useState("");
  const [size, setSize] = useState<SessionSize>("S");
  const [hours, setHours] = useState(2);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listEnvironments()
      .then((envs) => setEnvironments(envs.filter((e) => e.latestReadyVersion)))
      .catch(() => setEnvironments([]));
    listArtifacts({ workspaceId, limit: 100 })
      .then((page) => setArtifacts(page.artifacts.filter((a) => a.status === "ready")))
      .catch(() => setArtifacts([]));
  }, [workspaceId]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = artifacts.filter((a) => !q || `${a.name} ${a.originalFilename} ${a.type}`.toLowerCase().includes(q));
    // Already-selected files stay visible.
    return [...artifacts.filter((a) => selected.includes(a.artifactId) && !matches.includes(a)), ...matches].slice(0, 100);
  }, [artifacts, search, selected]);

  const rate = list.sizes[size]?.hourly ?? 0;
  const maxCost = rate * (hours + 10 / 60);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await startSession({
        envId,
        artifactIds: selected,
        workspaceId,
        size,
        maxHours: hours,
        name: name.trim() || undefined,
      });
      try {
        sessionStorage.removeItem(NOTEBOOK_SELECTION_KEY);
      } catch {
        // nothing to clear
      }
      router.push(`/notebooks?id=${session.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the notebook");
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= list.limits.maxFiles ? cur : [...cur, id]));

  return (
    <form onSubmit={submit} className={`${cardClass} p-6 space-y-5`}>
      <h2 className="font-semibold text-slate-700">New notebook</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Environment</label>
          <select className={inputClass} value={envId} onChange={(e) => setEnvId(e.target.value)} disabled={busy}>
            {environments.length === 0 && <option value="platform-base">Analysis base</option>}
            {environments.map((env) => (
              <option key={env.envId} value={env.envId}>
                {env.name} (v{env.latestReadyVersion})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Name (optional)</label>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>
        <div>
          <label className={labelClass}>Size</label>
          <select className={inputClass} value={size} onChange={(e) => setSize(e.target.value as SessionSize)} disabled={busy}>
            {(Object.keys(list.sizes) as SessionSize[]).map((s) => (
              <option key={s} value={s}>
                {s}: {list.sizes[s].vcpu} vCPU, {list.sizes[s].memoryMiB / 1024} GB · {formatMoney(list.sizes[s].hourly)}/hour
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Time limit</label>
          <select className={inputClass} value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={busy}>
            {Array.from({ length: list.limits.maxHours }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>
                {h} hour{h > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-end justify-between gap-3 mb-2">
          <label className={labelClass}>
            Files to open ({selected.length} selected, up to {list.limits.maxFiles})
          </label>
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Filter by name or type"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="max-h-64 overflow-auto border border-line rounded-lg divide-y divide-slate-50">
          {shown.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-400">No ready files{search ? " match" : ""}.</p>
          ) : (
            shown.map((a) => (
              <label key={a.artifactId} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-surface-muted">
                <input type="checkbox" checked={selected.includes(a.artifactId)} onChange={() => toggle(a.artifactId)} disabled={busy} />
                <span className="flex-1 text-slate-700 break-all">{a.originalFilename || a.name}</span>
                <span className="text-xs text-slate-400">{a.type}</span>
                <span className="text-xs text-slate-400 whitespace-nowrap">{formatBytes(a.sizeBytes)}</span>
              </label>
            ))
          )}
        </div>
        {selected.length > 0 && !artifacts.length && (
          <p className="text-xs text-slate-400 mt-1">{selected.length} file(s) chosen on the Artifacts page.</p>
        )}
      </div>

      <p className="text-sm text-slate-600">
        Maximum cost <strong>{formatMoney(maxCost)}</strong> (held from your budget until it stops). It stops after{" "}
        {list.limits.idleMinutes} minutes with no tab open, or at its time limit. Only <code>/work/notebooks</code> is kept
        between sessions.
        {list.network !== "up" && " The private network is off after a quiet period, so it opens about 2–3 minutes after you start it."}
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-3">
        <button type="button" className={secondaryButton} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={primaryButton} disabled={busy}>
          {busy ? "Starting…" : "Start notebook"}
        </button>
      </div>
    </form>
  );
}

// --- List -------------------------------------------------------------------------------------

function NotebooksContent() {
  const params = useSearchParams();
  const router = useRouter();
  const sessionId = params.get("id");
  const prefill = { envId: params.get("env") ?? undefined, selection: params.get("selection") === "1" };
  const prefilled = Boolean(prefill.envId || prefill.selection);
  const [creating, setCreating] = useState(prefilled);
  const [list, setList] = useState<SessionList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId) return;
    listSessions()
      .then(setList)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load notebooks"));
  }, [sessionId]);

  if (sessionId) return <SessionView sessionId={sessionId} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notebooks"
        description="JupyterLab on one of your environments, with the files you choose. No internet; your notebooks folder is kept between sessions."
        actions={
          !creating && (
            <Button icon={Plus} onClick={() => setCreating(true)}>
              New notebook
            </Button>
          )
        }
      />

      {creating && list && (
        <NewSessionForm
          list={list}
          prefill={prefill}
          onCancel={() => {
            setCreating(false);
            if (prefilled) router.replace("/notebooks");
          }}
        />
      )}

      {error && <Alert tone="error">{error}</Alert>}
      <div className={`${cardClass} overflow-hidden`}>
        {list === null ? (
          <p className="px-6 py-8 text-sm text-slate-400">Loading…</p>
        ) : list.sessions.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-400">No notebooks yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 bg-surface-muted/60 border-b border-line">
                <th className="px-6 py-3 font-medium text-xs uppercase">Notebook</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Status</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Cost</th>
                <th className="px-3 py-3 font-medium text-xs uppercase">Started</th>
              </tr>
            </thead>
            <tbody>
              {list.sessions.map((s: Session) => (
                <tr
                  key={s.sessionId}
                  className="border-b border-slate-50 hover:bg-surface-muted/80 cursor-pointer"
                  onClick={() => router.push(`/notebooks?id=${s.sessionId}`)}
                >
                  <td className="px-6 py-3">
                    <p className="font-medium text-slate-800">{s.name}</p>
                    <p className="text-xs text-slate-400">
                      {s.envName} v{s.envVersion} · {s.size} · {s.inputCount} file(s)
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={s.status} title={s.statusReason} />
                  </td>
                  <td className="px-3 py-3 text-slate-500">
                    {ACTIVE_SESSION_STATUSES.includes(s.status) ? "open" : formatMoney(s.costProvisional)}
                  </td>
                  <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{formatDate(s.startedAt ?? s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ScopedNotebooks() {
  const router = useRouter();
  const params = useSearchParams();
  const { scope, scopeReady } = useWorkspace();
  const key = scopeKey(scope);

  // Files picked in one scope aren't carried into another (as on Runs).
  const openedIn = useRef<string | null>(null);
  useEffect(() => {
    if (!scopeReady) return;
    if (openedIn.current === null) openedIn.current = key;
    else if (openedIn.current !== key) {
      openedIn.current = key;
      if (!params.get("id") && params.toString()) router.replace("/notebooks");
    }
  }, [key, scopeReady, params, router]);

  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  return <NotebooksContent key={key} />;
}

export default function NotebooksPage() {
  const ready = useRequireUser();
  if (!ready) return null;
  return (
    <Suspense fallback={<p className="text-sm text-slate-400">Loading…</p>}>
      <ScopedNotebooks />
    </Suspense>
  );
}
