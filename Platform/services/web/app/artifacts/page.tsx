"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { getDevices, type Device } from "@/lib/devices";
import {
  ARTIFACT_TYPES,
  formatBytes,
  getArtifactDownloadUrl,
  listArtifacts,
  type Artifact,
  type ArtifactType,
} from "@/lib/artifacts";
import ArtifactUploader from "@/app/components/ArtifactUploader";

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
  const { user, loading } = useAuth();
  const router = useRouter();

  const [devices, setDevices] = useState<Device[]>([]);
  const [filters, setFilters] = useState<Filters>({ type: "", tag: "", batchId: "" });
  const [tagInput, setTagInput] = useState("");

  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Ignores responses from requests that were superseded by a newer load.
  const loadIdRef = useRef(0);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  useEffect(() => {
    if (loading || !user) return;
    getDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [user, loading]);

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
          nextToken: token,
        });
        if (loadId !== loadIdRef.current) return;
        setArtifacts((current) => (append && current ? [...current, ...page.artifacts] : page.artifacts));
        setNextToken(page.nextToken);
      } catch (err) {
        if (loadId !== loadIdRef.current) return;
        setListError(err instanceof Error ? err.message : "Failed to load artifacts");
      } finally {
        if (loadId === loadIdRef.current) setListLoading(false);
      }
    },
    [filters]
  );

  useEffect(() => {
    if (loading || !user) return;
    void load(false);
  }, [user, loading, load]);

  // Multipart uploads are checked in the background after they complete;
  // keep the list fresh until they settle.
  const hasVerifying = artifacts?.some((a) => a.status === "verifying") ?? false;
  useEffect(() => {
    if (!hasVerifying) return;
    const timer = setTimeout(() => void load(false), REFRESH_WHILE_VERIFYING_MS);
    return () => clearTimeout(timer);
  }, [hasVerifying, artifacts, load]);

  async function download(artifact: Artifact) {
    setDownloadError(null);
    try {
      window.location.assign(await getArtifactDownloadUrl(artifact.artifactId));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    }
  }

  const deviceNames = new Map(devices.map((d) => [d.deviceId, d.name]));

  if (loading || !user) return null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Artifacts</h1>
        <p className="text-slate-400 mt-1 text-sm">
          Files from your reverse engineering work, ready for analysis
        </p>
      </div>

      <ArtifactUploader
        devices={devices}
        onFinished={(uploadBatchId) => {
          if (uploadBatchId) setFilters({ type: "", tag: "", batchId: uploadBatchId });
          else void load(false);
          setTagInput("");
        }}
      />

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-slate-700 mr-auto">Your artifacts</h2>

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
                <th className="px-6 py-3 font-medium text-xs uppercase tracking-wide">Name</th>
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
                  <td className="px-6 py-3">
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
