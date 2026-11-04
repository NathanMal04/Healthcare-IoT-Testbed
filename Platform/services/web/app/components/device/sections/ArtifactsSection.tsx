"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FolderArchive, Upload } from "lucide-react";
import { canEditDevice, type Device } from "@/lib/devices";
import {
  ARTIFACT_TYPE_LABELS,
  formatBytes,
  getArtifactDownloadUrl,
  listDeviceArtifacts,
  type Artifact,
  type ArtifactType,
} from "@/lib/artifacts";
import { useWorkspace } from "@/context/WorkspaceContext";
import ArtifactUploader from "@/app/components/ArtifactUploader";
import ArtifactTypeChips from "@/app/components/ArtifactTypeChips";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  RowActionsMenu,
  StatusBadge,
  Toolbar,
  formatDate,
  type Column,
} from "@/app/components/ui";

/** Every file linked to the device, by category, with the uploader and downloads. */
export default function ArtifactsSection({ device }: { device: Device }) {
  // Viewers browse and download; only contributors upload.
  const canUpload = canEditDevice(device);
  // The uploader locks the scope while it runs, so it can't be closed, nor
  // the category changed, mid-upload.
  const { scopeLocked } = useWorkspace();
  // The open uploader; fixedType is set when it was opened from a category.
  const [upload, setUpload] = useState<{ fixedType?: ArtifactType } | null>(null);
  const [type, setType] = useState<ArtifactType | "">("");
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const loadIdRef = useRef(0);

  const load = useCallback(
    async (append: boolean, token?: string) => {
      const loadId = ++loadIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await listDeviceArtifacts(device.deviceId, {
          limit: 100,
          type: type || undefined,
          nextToken: token,
        });
        if (loadId !== loadIdRef.current) return;
        setArtifacts((current) => (append && current ? [...current, ...page.artifacts] : page.artifacts));
        setNextToken(page.nextToken);
      } catch (err) {
        if (loadId !== loadIdRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load artifacts");
      } finally {
        if (loadId === loadIdRef.current) setLoading(false);
      }
    },
    [device.deviceId, type]
  );

  useEffect(() => {
    void load(false);
    const loadIds = loadIdRef;
    return () => {
      loadIds.current++;
    };
  }, [load]);

  async function download(artifact: Artifact) {
    setDownloadError(null);
    try {
      window.location.assign(await getArtifactDownloadUrl(artifact.artifactId));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    }
  }

  const columns: Column<Artifact>[] = [
    {
      key: "name",
      header: "Name",
      cell: (a) => (
        <div className="max-w-xs">
          <p className="font-medium text-slate-800 break-all">{a.name}</p>
          {a.originalFilename !== a.name && <p className="text-xs text-slate-500 break-all">{a.originalFilename}</p>}
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      className: "whitespace-nowrap text-slate-700",
      cell: (a) => (
        <>
          <span>{ARTIFACT_TYPE_LABELS[a.type]?.single ?? a.type}</span>
          {a.version && <span className="text-slate-400"> · {a.version}</span>}
        </>
      ),
    },
    { key: "status", header: "Status", cell: (a) => <StatusBadge status={a.status} title={a.statusReason ?? undefined} /> },
    { key: "size", header: "Size", hideBelow: "sm", className: "whitespace-nowrap text-slate-600 tabular-nums", cell: (a) => formatBytes(a.sizeBytes) },
    {
      key: "uploaded",
      header: "Uploaded",
      hideBelow: "lg",
      className: "whitespace-nowrap text-slate-500",
      cell: (a) => formatDate(a.uploadedAt ?? a.createdAt),
    },
    {
      key: "actions",
      header: "Actions",
      headerClassName: "text-right",
      className: "text-right",
      cell: (a) => (
        <RowActionsMenu
          label={`Actions for ${a.name}`}
          actions={[a.status === "ready" && { label: "Download", icon: Download, onSelect: () => void download(a) }]}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {upload && (
        <ArtifactUploader
          key={upload.fixedType ?? "all"}
          devices={[device]}
          fixedDevice={device}
          fixedType={upload.fixedType}
          onFinished={(uploadBatchId, failedCount) => {
            void load(false);
            // With failures the uploader stays, so they can be reviewed or retried.
            if (uploadBatchId && failedCount === 0) setUpload(null);
          }}
        />
      )}
      <Card className="overflow-hidden">
        <CardHeader
          title="Artifacts"
          description="Every file linked to this device, including firmware"
          actions={
            !canUpload ? undefined : upload ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setUpload(null)}
                disabled={scopeLocked}
                title={scopeLocked ? "Cancel the running upload first" : undefined}
              >
                Close uploader
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={Upload}
                onClick={() => setUpload(type ? { fixedType: type } : {})}
              >
                {type ? `Upload ${ARTIFACT_TYPE_LABELS[type].single}` : "Upload new artifact"}
              </Button>
            )
          }
        />
        <Toolbar>
          <ArtifactTypeChips
            value={type}
            onChange={setType}
            disabled={scopeLocked}
            disabledTitle="Wait for the running upload to finish"
          />
        </Toolbar>
        {downloadError && (
          <Alert tone="error" className="mx-5 mt-3">
            Couldn&apos;t download: {downloadError}
          </Alert>
        )}
        {error ? (
          <ErrorState title="Couldn't load artifacts" message={error} />
        ) : artifacts === null ? (
          <LoadingState label="Loading artifacts…" />
        ) : artifacts.length === 0 && !nextToken ? (
          <EmptyState
            icon={FolderArchive}
            title={type ? `No ${ARTIFACT_TYPE_LABELS[type].category} linked to this device` : "No files linked to this device yet"}
          />
        ) : (
          <DataTable columns={columns} rows={artifacts} rowKey={(a) => a.artifactId} minWidth="36rem" />
        )}
        {nextToken && !error && (
          <div className="px-5 py-3 border-t border-line text-center">
            <Button variant="secondary" size="sm" onClick={() => void load(true, nextToken)} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
