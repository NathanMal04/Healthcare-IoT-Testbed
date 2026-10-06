"use client";

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
import { Download, FolderArchive, Layers, Play, RefreshCw, X } from "lucide-react";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  FilterSelect,
  LoadingState,
  PageHeader,
  RowActionsMenu,
  StatusBadge,
  Toolbar,
  formatDate,
  type Column,
} from "@/app/components/ui";

const REFRESH_WHILE_VERIFYING_MS = 5000;

interface Filters {
  type: ArtifactType | "";
  tag: string;
  batchId: string;
}

export default function ArtifactsPage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
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

  function runOn(artifactIds: string[]) {
    try {
      sessionStorage.setItem(RUN_SELECTION_KEY, JSON.stringify(artifactIds));
    } catch {
      setDownloadError("Your browser blocked session storage, so the selection can't be passed on");
      return;
    }
    router.push("/runs?selection=1");
  }

  if (loading || !user) return null;

  const columns: Column<Artifact>[] = [
    ...(runsAvailable
      ? [
          {
            key: "select",
            header: (
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all shown" className="rounded border-line-strong" />
            ),
            headerClassName: "w-8",
            cell: (artifact: Artifact) => (
              <input
                type="checkbox"
                checked={selectedIds.has(artifact.artifactId)}
                disabled={artifact.status !== "ready"}
                onChange={() => toggle(artifact.artifactId)}
                aria-label={`Select ${artifact.name}`}
                className="rounded border-line-strong"
              />
            ),
          } satisfies Column<Artifact>,
        ]
      : []),
    {
      key: "name",
      header: "Name",
      cell: (artifact) => (
        <div className="min-w-0 max-w-xs">
          <p className="font-medium text-slate-800 break-all">{artifact.name}</p>
          {artifact.originalFilename !== artifact.name && (
            <p className="text-xs text-slate-500 break-all">{artifact.originalFilename}</p>
          )}
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      className: "whitespace-nowrap text-slate-700",
      cell: (artifact) => (
        <>
          <span className="capitalize">{artifact.type}</span>
          {artifact.version && <span className="text-slate-400"> · {artifact.version}</span>}
        </>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (artifact) => <StatusBadge status={artifact.status} title={artifact.statusReason ?? undefined} />,
    },
    {
      key: "size",
      header: "Size",
      hideBelow: "sm",
      className: "whitespace-nowrap text-slate-600 tabular-nums",
      cell: (artifact) => formatBytes(artifact.sizeBytes),
    },
    {
      key: "links",
      header: "Tags / devices",
      hideBelow: "md",
      cell: (artifact) => (
        <div className="flex flex-wrap gap-1 max-w-[16rem]">
          {artifact.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => {
                setTagInput(tag);
                setFilters((f) => ({ ...f, tag }));
              }}
              className="text-xs bg-surface-sunken hover:bg-line text-slate-700 px-1.5 py-0.5 rounded-md"
              title={`Filter by tag ${tag}`}
            >
              {tag}
            </button>
          ))}
          {artifact.deviceIds.map((id) => (
            <span key={id} className="text-xs bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded-md">
              {deviceNames.get(id) ?? "device"}
            </span>
          ))}
          {!artifact.tags.length && !artifact.deviceIds.length && <span className="text-slate-300">—</span>}
        </div>
      ),
    },
    {
      key: "uploaded",
      header: "Uploaded",
      hideBelow: "lg",
      className: "whitespace-nowrap text-slate-500",
      cell: (artifact) => formatDate(artifact.uploadedAt ?? artifact.createdAt),
    },
    {
      key: "actions",
      header: "Actions",
      headerClassName: "text-right",
      className: "text-right",
      cell: (artifact) => (
        <RowActionsMenu
          label={`Actions for ${artifact.name}`}
          actions={[
            artifact.status === "ready" && { label: "Download", icon: Download, onSelect: () => void download(artifact) },
            runsAvailable &&
              artifact.status === "ready" && {
                label: "Run a script",
                icon: Play,
                onSelect: () => runOn([artifact.artifactId]),
              },
            !!artifact.uploadBatchId &&
              artifact.uploadBatchId !== filters.batchId && {
                label: "Show upload batch",
                icon: Layers,
                onSelect: () => setFilters({ type: "", tag: "", batchId: artifact.uploadBatchId! }),
              },
          ]}
        />
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Artifacts"
        description="Files from your reverse-engineering work, ready for analysis"
        scope={scope}
      />

      <ArtifactUploader
        devices={devices}
        requireDevice={scope.kind === "workspace"}
        onFinished={(uploadBatchId) => {
          if (uploadBatchId) setFilters({ type: "", tag: "", batchId: uploadBatchId });
          else void load(false);
          setTagInput("");
        }}
      />

      <Card className="overflow-hidden">
        <CardHeader
          title={scope.kind === "workspace" ? `${scope.name} artifacts` : "Your artifacts"}
          description={
            runsAvailable ? "Select ready files to run a script on them." : "Workspace analysis runs are not available yet."
          }
          actions={
            runsAvailable && selectedIds.size > 0 ? (
              <div className="flex items-center gap-2">
                <Button size="sm" icon={Play} onClick={() => runOn(Array.from(selectedIds))}>
                  Run a script on selected ({selectedIds.size})
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                  Clear selection
                </Button>
              </div>
            ) : undefined
          }
        />

        <Toolbar>
          <FilterSelect
            value={filters.type}
            onChange={(value) => setFilters((f) => ({ ...f, type: value as ArtifactType | "" }))}
            ariaLabel="Artifact type"
          >
            <option value="">All types</option>
            {ARTIFACT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </FilterSelect>

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
              aria-label="Filter by tag"
              className="h-9 w-40 px-3 rounded-lg border border-line bg-white text-sm text-slate-800 placeholder:text-slate-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
            />
          </form>

          {filters.batchId && (
            <span className="inline-flex items-center gap-1.5 h-8 text-xs bg-brand-50 text-brand-700 pl-2.5 pr-1.5 rounded-lg ring-1 ring-inset ring-brand-100">
              Upload batch {filters.batchId.slice(0, 8)}
              <button
                type="button"
                aria-label="Clear batch filter"
                onClick={() => setFilters((f) => ({ ...f, batchId: "" }))}
                className="p-0.5 rounded hover:bg-brand-100"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          )}
          {runsAvailable && filters.batchId && (
            <ButtonLink href={`/runs?batch=${filters.batchId}`} variant="link" size="sm">
              Run a script on this upload
            </ButtonLink>
          )}

          <Button
            variant="ghost"
            size="sm"
            icon={RefreshCw}
            onClick={() => void load(false)}
            disabled={listLoading}
            className="ml-auto"
          >
            Refresh
          </Button>
        </Toolbar>

        {downloadError && (
          <Alert tone="error" className="mx-5 mt-3">
            Couldn&apos;t download: {downloadError}
          </Alert>
        )}

        {listError ? (
          <ErrorState title="Couldn't load artifacts" message={listError} />
        ) : artifacts === null ? (
          <LoadingState label="Loading artifacts…" />
        ) : artifacts.length === 0 && !nextToken ? (
          <EmptyState
            icon={FolderArchive}
            title="No artifacts match"
            description="Upload files above, or change the filters."
          />
        ) : (
          <DataTable columns={columns} rows={artifacts} rowKey={(a) => a.artifactId} minWidth="40rem" />
        )}

        {nextToken && !listError && (
          <div className="px-5 py-3 border-t border-line text-center">
            <Button variant="secondary" size="sm" onClick={() => void load(true, nextToken)} disabled={listLoading}>
              {listLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
