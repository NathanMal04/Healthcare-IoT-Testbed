"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { getDevices, type Device } from "@/lib/devices";
import {
  ARTIFACT_TYPES,
  formatBytes,
  getArtifact,
  getArtifactDownloadUrl,
  listArtifacts,
  type Artifact,
  type ArtifactType,
} from "@/lib/artifacts";
import ArtifactUploader from "@/app/components/ArtifactUploader";
import { RUN_SELECTION_KEY } from "@/lib/runs";
import { useWorkspace } from "@/context/WorkspaceContext";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId } from "@/lib/workspaces";

const STATUS_BADGE_STYLES: Record<string, string> = {
  ready: "text-emerald-700 bg-emerald-50",
  pending: "text-amber-700 bg-amber-50",
  verifying: "text-blue-700 bg-blue-50",
  failed: "text-red-700 bg-red-50",
};

const REFRESH_WHILE_VERIFYING_MS = 5000;

interface Filters {
  type: ArtifactType | "";
  tag: string;
  batchId: string;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function ArtifactsPage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <p className="text-sm text-slate-400">Loading workspace…</p>;
  // Keyed on the scope: switching remounts the view, so filters, pagination,
  // selection and staged uploads reset, and a late response for the previous
  // scope lands in the unmounted view instead of this one.
  return <ArtifactsView key={scopeKey(scope)} />;
}

function ArtifactsView() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);
  // Runs can't use workspace files yet, so the run shortcuts are Personal only.
  const runsAvailable = scope.kind === "personal";

  const [devices, setDevices] = useState<Device[]>([]);
  const [filters, setFilters] = useState<Filters>({ type: "", tag: "", batchId: "" });
  const [tagInput, setTagInput] = useState("");

  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Ignores responses from requests that were superseded by a newer load.
  const loadIdRef = useRef(0);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  useEffect(() => {
    if (loading || !user) return;
    getDevices(workspaceId)
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [user, loading, workspaceId]);

  const load = useCallback(
    async (append: boolean, token?: string) => {
      const loadId = ++loadIdRef.current;
      setListLoading(true);
      setListError(null);
      try {
        const page = await listArtifacts({
          type: filters.type || undefined,
          tag: filters.tag || undefined,
          batchId: filters.batchId || undefined,
          // A batch already has a scope; otherwise list the workspace's files.
          workspaceId: filters.batchId ? undefined : workspaceId,
          nextToken: token,
        });
        if (loadId !== loadIdRef.current) return;
        setArtifacts((current) => (append && current ? [...current, ...page.artifacts] : page.artifacts));
        setNextToken(page.nextToken);
      } catch (err) {
        if (loadId !== loadIdRef.current) return;
        setListError(err instanceof Error ? err.message : "Failed to load artifacts");
        if (workspaceId && isWorkspaceUnavailable(err)) reportWorkspaceUnavailable();
      } finally {
        if (loadId === loadIdRef.current) setListLoading(false);
      }
    },
    [filters, workspaceId, reportWorkspaceUnavailable]
  );

  useEffect(() => {
    if (loading || !user) return;
    void load(false);
  }, [user, loading, load]);

  // Multipart uploads are checked in the background after they complete.
  // Until they settle, re-read just those rows and merge them in place, so
  // pages already loaded with "Load more" stay put.
  const verifyingIds = (artifacts ?? [])
    .filter((a) => a.status === "verifying")
    .map((a) => a.artifactId)
    .join(",");
  useEffect(() => {
    if (!verifyingIds) return;
    const timer = setTimeout(async () => {
      const ids = verifyingIds.split(",").slice(0, 20);
      const fresh = await Promise.all(ids.map((id) => getArtifact(id).catch(() => null)));
      const byId = new Map(fresh.filter((a) => a !== null).map((a) => [a.artifactId, a]));
      setArtifacts((current) => current?.map((a) => byId.get(a.artifactId) ?? a) ?? current);
    }, REFRESH_WHILE_VERIFYING_MS);
    return () => clearTimeout(timer);
  }, [verifyingIds, artifacts]);

  async function download(artifact: Artifact) {
    setDownloadError(null);
    try {
      window.location.assign(await getArtifactDownloadUrl(artifact.artifactId));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    }
  }

  const deviceNames = new Map(devices.map((d) => [d.deviceId, d.name]));
  const selectable = (artifacts ?? []).filter((a) => a.status === "ready");
  const allSelected = selectable.length > 0 && selectable.every((a) => selectedIds.has(a.artifactId));

  function toggle(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const a of selectable) {
        if (allSelected) next.delete(a.artifactId);
        else next.add(a.artifactId);
      }
      return next;
    });
  }

  function runOnSelected() {
    try {
      sessionStorage.setItem(RUN_SELECTION_KEY, JSON.stringify(Array.from(selectedIds)));
    } catch {
      setDownloadError("Your browser blocked session storage, so the selection can't be passed on");
      return;
    }
    router.push("/runs?selection=1");
  }

  if (loading || !user) return null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Artifacts</h1>
        <p className="text-slate-400 mt-1 text-sm">
          Files from your reverse engineering work, ready for analysis
          {" · "}
          {scope.kind === "workspace" ? (
            <span className="text-slate-600">
              Workspace: <span className="font-medium">{scope.name}</span>
            </span>
          ) : (
            <span className="text-slate-600">Personal</span>
          )}
        </p>
      </div>

      <ArtifactUploader
        devices={devices}
        requireDevice={scope.kind === "workspace"}
        onFinished={(uploadBatchId) => {
          if (uploadBatchId) setFilters({ type: "", tag: "", batchId: uploadBatchId });
          else void load(false);
          setTagInput("");
        }}
      />

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-700 mr-auto">
            {scope.kind === "workspace" ? `${scope.name} artifacts` : "Your artifacts"}
          </h2>

          {!runsAvailable && (
            <span className="text-xs text-slate-400">Workspace analysis runs are not available yet.</span>
          )}

          {runsAvailable && selectedIds.size > 0 && (
            <>
              <button type="button" onClick={runOnSelected} className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg font-medium">
                Run a script on selected ({selectedIds.size})
              </button>
              <button type="button" onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-500 hover:text-slate-700">
                Clear selection
              </button>
            </>
          )}

          {filters.batchId && (
            <span className="text-xs bg-blue-50 text-blue-700 px-2.5 py-1 rounded-full flex items-center gap-2">
              Upload batch {filters.batchId.slice(0, 8)}
              <button
                type="button"
                aria-label="Clear batch filter"
                onClick={() => setFilters((f) => ({ ...f, batchId: "" }))}
                className="hover:text-blue-900"
              >
                ✕
              </button>
            </span>
          )}
          {runsAvailable && filters.batchId && (
            <Link href={`/runs?batch=${filters.batchId}`} className="text-xs text-blue-600 font-medium">
              Run a script on this upload
            </Link>
          )}

          <select
            value={filters.type}
            onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as ArtifactType | "" }))}
            className="text-sm border border-slate-200 rounded-lg px-2 py-1.5"
          >
            <option value="">All types</option>
            {ARTIFACT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setFilters((f) => ({ ...f, tag: tagInput.trim() }));
            }}
          >
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onBlur={() => setFilters((f) => ({ ...f, tag: tagInput.trim() }))}
              placeholder="Filter by tag"
              className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 w-40"
            />
          </form>

          <button
            type="button"
            onClick={() => void load(false)}
            disabled={listLoading}
            className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {downloadError && (
          <p className="text-xs text-red-600 bg-red-50 px-6 py-2">Couldn&apos;t download: {downloadError}</p>
        )}

        {listError ? (
          <div className="px-6 py-8 text-sm text-red-600">Couldn&apos;t load artifacts: {listError}</div>
        ) : artifacts === null ? (
          <div className="px-6 py-8 text-sm text-slate-400">Loading artifacts…</div>
        ) : artifacts.length === 0 && !nextToken ? (
          <div className="px-6 py-8 text-sm text-slate-400">No artifacts match.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 bg-slate-50/60 border-b border-slate-100">
                {runsAvailable && (
                  <th className="pl-6 py-3 w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all shown" />
                  </th>
                )}
                <th className={`${runsAvailable ? "px-3" : "pl-6 pr-3"} py-3 font-medium text-xs uppercase tracking-wide`}>Name</th>
                <th className="px-3 py-3 font-medium text-xs uppercase tracking-wide">Type</th>
                <th className="px-3 py-3 font-medium text-xs uppercase tracking-wide">Status</th>
                <th className="px-3 py-3 font-medium text-xs uppercase tracking-wide">Size</th>
                <th className="px-3 py-3 font-medium text-xs uppercase tracking-wide">Tags / devices</th>
                <th className="px-3 py-3 font-medium text-xs uppercase tracking-wide">Uploaded</th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {artifacts.map((artifact) => (
                <tr key={artifact.artifactId} className="border-b border-slate-50 hover:bg-slate-50/80">
                  {runsAvailable && (
                    <td className="pl-6 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(artifact.artifactId)}
                        disabled={artifact.status !== "ready"}
                        onChange={() => toggle(artifact.artifactId)}
                        aria-label={`Select ${artifact.name}`}
                      />
                    </td>
                  )}
                  <td className={`${runsAvailable ? "px-3" : "pl-6 pr-3"} py-3`}>
                    <p className="font-medium text-slate-800 break-all">{artifact.name}</p>
                    {artifact.originalFilename !== artifact.name && (
                      <p className="text-xs text-slate-400 break-all">{artifact.originalFilename}</p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-slate-600 whitespace-nowrap">
                    {artifact.type}
                    {artifact.version && <span className="text-slate-400"> · {artifact.version}</span>}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        STATUS_BADGE_STYLES[artifact.status] ?? "text-slate-600 bg-slate-100"
                      }`}
                      title={artifact.statusReason ?? undefined}
                    >
                      {artifact.status}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{formatBytes(artifact.sizeBytes)}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {artifact.tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => {
                            setTagInput(tag);
                            setFilters((f) => ({ ...f, tag }));
                          }}
                          className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-0.5 rounded"
                        >
                          {tag}
                        </button>
                      ))}
                      {artifact.deviceIds.map((id) => (
                        <span key={id} className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">
                          {deviceNames.get(id) ?? "device"}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-slate-500 whitespace-nowrap">
                    {formatDate(artifact.uploadedAt ?? artifact.createdAt)}
                  </td>
                  <td className="px-6 py-3 text-right whitespace-nowrap space-x-3">
                    {artifact.uploadBatchId && artifact.uploadBatchId !== filters.batchId && (
                      <button
                        type="button"
                        onClick={() => setFilters({ type: "", tag: "", batchId: artifact.uploadBatchId! })}
                        className="text-xs text-slate-500 hover:text-slate-700"
                      >
                        Batch
                      </button>
                    )}
                    {artifact.status === "ready" && (
                      <button
                        type="button"
                        onClick={() => void download(artifact)}
                        className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                      >
                        Download
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {nextToken && !listError && (
          <div className="px-6 py-4 border-t border-slate-100 text-center">
            <button
              type="button"
              onClick={() => void load(true, nextToken)}
              disabled={listLoading}
              className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
            >
              {listLoading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
