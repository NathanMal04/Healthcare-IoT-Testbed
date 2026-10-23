"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  createEnvironment,
  createEnvironmentVersion,
  getBuildLog,
  getCatalog,
  getEnvironment,
  getPackages,
  listEnvironments,
  type CatalogItem,
  type Environment,
  type EnvironmentVersion,
} from "@/lib/builds";
import {
  Alert,
  Button,
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

const POLL_MS = 10000;

function CatalogPicker({
  catalog,
  selected,
  disabled,
  exclude = [],
  onChange,
}: {
  catalog: CatalogItem[];
  selected: string[];
  disabled?: boolean;
  exclude?: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="grid sm:grid-cols-2 gap-2">
      {catalog
        .filter((item) => !exclude.includes(item.id))
        .map((item) => {
          const checked = selected.includes(item.id);
          return (
            <label
              key={item.id}
              className={`flex gap-2 items-start text-sm border rounded-lg px-3 py-2 cursor-pointer ${
                checked ? "border-brand-500 bg-brand-50" : "border-line"
              }`}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(checked ? selected.filter((i) => i !== item.id) : [...selected, item.id])}
              />
              <span>
                <span className="font-medium text-slate-700">{item.name}</span>
                <span className="block text-xs text-slate-400">{item.description}</span>
              </span>
            </label>
          );
        })}
    </div>
  );
}

export default function EnvironmentsPage() {
  const ready = useRequireUser();
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState("platform-base");
  const [items, setItems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ environment: Environment; versions: EnvironmentVersion[] } | null>(null);
  const [additions, setAdditions] = useState<string[]>([]);
  const [viewer, setViewer] = useState<{ title: string; text: string | null; loading: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setEnvironments(await listEnvironments());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load environments");
    }
  }, []);

  const loadDetail = useCallback(async (envId: string) => {
    try {
      setDetail(await getEnvironment(envId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the environment");
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void load();
    getCatalog().then(setCatalog).catch(() => setCatalog([]));
  }, [ready, load]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
    else setDetail(null);
    setAdditions([]);
  }, [selected, loadDetail]);

  // Builds take a few minutes; refresh while any version is still building.
  const building = detail?.versions.some((v) => v.status === "building" || v.status === "pending") ?? false;
  useEffect(() => {
    if (!building || !selected) return;
    const timer = setTimeout(() => void loadDetail(selected), POLL_MS);
    return () => clearTimeout(timer);
  }, [building, selected, detail, loadDetail]);

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const result = await createEnvironment({ name: name.trim(), base, catalogItems: items });
      setCreating(false);
      setName("");
      setItems([]);
      await load();
      setSelected(result.environment.envId);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create the environment");
    } finally {
      setBusy(false);
    }
  }

  async function addTools() {
    if (!selected || additions.length === 0) return;
    setBusy(true);
    setFormError(null);
    try {
      await createEnvironmentVersion(selected, { catalogItems: additions });
      setAdditions([]);
      await loadDetail(selected);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to start the build");
    } finally {
      setBusy(false);
    }
  }

  async function show(kind: "log" | "packages", version: EnvironmentVersion) {
    const title = kind === "log" ? `Build log · v${version.version}` : `Installed packages · v${version.version}`;
    setViewer({ title, text: null, loading: true });
    try {
      if (kind === "log") {
        const log = await getBuildLog("environments", version.envId, version.version);
        setViewer({ title, text: log.lines.join("\n") || log.note || "", loading: false });
      } else {
        const packages = await getPackages("environments", version.envId, version.version);
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

  if (!ready) return null;
  const latest = detail?.versions.find((v) => v.status === "ready");
  const isPlatform = detail?.environment.envId.startsWith("platform-");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Environments"
        description="The tools a script's container has. Scripts without one use the analysis base."
        actions={
          <Button icon={Plus} onClick={() => setCreating(true)}>
            New environment
          </Button>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}

      {creating && (
        <form onSubmit={submitCreate} className={`${cardClass} p-6 space-y-4`}>
          <h2 className="font-semibold text-slate-700">New environment</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Name</label>
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Firmware RE tools" />
            </div>
            <div>
              <label className={labelClass}>Start from</label>
              <select className={inputClass} value={base} onChange={(e) => setBase(e.target.value)}>
                <option value="platform-base">Analysis base</option>
                <option value="platform-ghidra">Analysis base + Ghidra</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass}>Tools to add</label>
            <CatalogPicker catalog={catalog} selected={items} disabled={busy} onChange={setItems} />
          </div>
          {formError && <Alert tone="error">{formError}</Alert>}
          <div className="flex justify-end gap-3">
            <button type="button" className={secondaryButton} onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={primaryButton} disabled={busy || !name.trim()}>
              {busy ? "Starting build…" : "Create and build"}
            </button>
          </div>
        </form>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        {environments === null ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          environments.map((env) => (
            <button
              key={env.envId}
              type="button"
              onClick={() => setSelected(env.envId)}
              className={`${cardClass} p-4 text-left hover:shadow-md transition-shadow ${
                selected === env.envId ? "ring-2 ring-brand-500" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800">{env.name}</span>
                {env.platform && <span className="text-xs bg-surface-sunken text-slate-500 px-2 py-0.5 rounded">platform</span>}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                {env.latestReadyVersion ? `v${env.latestReadyVersion} ready` : "no ready version yet"}
              </p>
            </button>
          ))
        )}
      </div>

      {detail && (
        <div className={`${cardClass} p-6 space-y-5`}>
          <div>
            <h2 className="font-semibold text-slate-700">{detail.environment.name}</h2>
            {detail.environment.description && <p className="text-sm text-slate-500 mt-1">{detail.environment.description}</p>}
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-line">
                <th className="py-2 font-medium text-xs uppercase">Version</th>
                <th className="py-2 font-medium text-xs uppercase">Status</th>
                <th className="py-2 font-medium text-xs uppercase">Tools added</th>
                <th className="py-2 font-medium text-xs uppercase">Created</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {detail.versions.map((v) => (
                <tr key={v.version} className="border-b border-slate-50 align-top">
                  <td className="py-2 font-medium text-slate-700">
                    v{v.version}
                    {v.basedOn && <span className="block text-xs text-slate-400">from {v.basedOn}</span>}
                    {v.parentVersion && <span className="block text-xs text-slate-400">from v{v.parentVersion}</span>}
                  </td>
                  <td className="py-2">
                    <StatusBadge status={v.status} />
                    {v.statusReason && <p className="text-xs text-red-600 mt-1 max-w-xs">{v.statusReason}</p>}
                  </td>
                  <td className="py-2 text-slate-500">{(v.catalogItems ?? []).join(", ") || "—"}</td>
                  <td className="py-2 text-slate-500 whitespace-nowrap">{formatDate(v.createdAt)}</td>
                  <td className="py-2 text-right whitespace-nowrap space-x-3">
                    {!isPlatform && (
                      <button type="button" className="text-xs text-brand-600" onClick={() => void show("log", v)}>
                        Log
                      </button>
                    )}
                    {v.status === "ready" && (
                      <button type="button" className="text-xs text-brand-600" onClick={() => void show("packages", v)}>
                        Packages
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!isPlatform && latest && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-600">Add tools (builds v{detail.environment.latestVersion + 1} from v{latest.version})</h3>
              <CatalogPicker
                catalog={catalog}
                selected={additions}
                exclude={latest.catalogItems ?? []}
                disabled={busy}
                onChange={setAdditions}
              />
              {formError && <Alert tone="error">{formError}</Alert>}
              <button type="button" className={primaryButton} disabled={busy || additions.length === 0} onClick={() => void addTools()}>
                Build new version
              </button>
            </div>
          )}
        </div>
      )}

      {viewer && <TextModal title={viewer.title} text={viewer.text} loading={viewer.loading} onClose={() => setViewer(null)} />}
    </div>
  );
}
