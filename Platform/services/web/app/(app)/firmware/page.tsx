"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Microchip, RefreshCw, Upload } from "lucide-react";
import { listArtifacts, firmwareReverseEngineeringStatus, type Artifact } from "@/lib/artifacts";
import { getDevices, type Device } from "@/lib/devices";
import {
  REVERSE_ENGINEERING_STATUSES,
  REVERSE_ENGINEERING_STATUS_LABELS,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";
import { useWorkspace } from "@/context/WorkspaceContext";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import FirmwareUploadDialog from "@/app/components/firmware/FirmwareUploadDialog";
import { FirmwareRetryDialog, FirmwareTable, useFirmwareReStatus } from "@/app/components/firmware/FirmwareList";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FilterSelect,
  LoadingState,
  PageHeader,
  SearchInput,
  Toolbar,
} from "@/app/components/ui";

export default function FirmwarePage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  // Keyed on the scope: switching remounts the view, so nothing carries over.
  return <FirmwareView key={scopeKey(scope)} />;
}

function FirmwareView() {
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const [firmware, setFirmware] = useState<Artifact[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [query, setQuery] = useState("");
  const [reFilter, setReFilter] = useState<ReverseEngineeringStatus | "">("");
  const [uploading, setUploading] = useState(false);
  const [retryFirmware, setRetryFirmware] = useState<Artifact | null>(null);
  const { savingReIds, reError, setReError, changeReStatus } = useFirmwareReStatus(setFirmware);

  // Ignores responses from requests that were superseded by a newer load.
  const loadIdRef = useRef(0);

  // Firmware is an artifact with type=firmware. The list is paged by the
  // underlying artifact list (100 rows), and the type is filtered after
  // paging, so a page can hold few firmware rows and still have more after it.
  const load = useCallback(
    async (append: boolean, token?: string) => {
      const loadId = ++loadIdRef.current;
      setListLoading(true);
      setListError(null);
      try {
        const page = await listArtifacts({ type: "firmware", workspaceId, limit: 100, nextToken: token });
        if (loadId !== loadIdRef.current) return;
        setFirmware((current) => (append && current ? [...current, ...page.artifacts] : page.artifacts));
        setNextToken(page.nextToken);
      } catch (err) {
        if (loadId !== loadIdRef.current) return;
        setListError(err instanceof Error ? err.message : "Failed to load firmware");
        if (workspaceId && isWorkspaceUnavailable(err)) reportWorkspaceUnavailable();
      } finally {
        if (loadId === loadIdRef.current) setListLoading(false);
      }
    },
    [workspaceId, reportWorkspaceUnavailable]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    let active = true;
    getDevices(workspaceId)
      .then((result) => {
        if (active) setDevices(result);
      })
      .catch(() => {
        if (active) setDevices([]);
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const deviceNames = useMemo(() => new Map((devices ?? []).map((d) => [d.deviceId, d.name])), [devices]);

  // Search and RE filter apply to the loaded pages only.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (firmware ?? []).filter((f) => {
      if (reFilter && firmwareReverseEngineeringStatus(f) !== reFilter) return false;
      if (!needle) return true;
      return [f.version ?? "", f.originalFilename, ...f.deviceIds.map((id) => deviceNames.get(id) ?? "")]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [firmware, query, reFilter, deviceNames]);
  const filtering = query.trim() !== "" || reFilter !== "";

  return (
    <div>
      <PageHeader
        title="Firmware"
        description="Firmware versions uploaded for your devices"
        scope={scope}
        actions={
          <Button icon={Upload} onClick={() => setUploading(true)}>
            Upload firmware
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <Toolbar>
          <SearchInput value={query} onChange={setQuery} placeholder="Search version, file or device" ariaLabel="Search firmware" />
          <FilterSelect
            value={reFilter}
            onChange={(value) => setReFilter(value as ReverseEngineeringStatus | "")}
            ariaLabel="Reverse-engineering status"
          >
            <option value="">All RE statuses</option>
            {REVERSE_ENGINEERING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {REVERSE_ENGINEERING_STATUS_LABELS[status]}
              </option>
            ))}
          </FilterSelect>
          {filtering && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                setReFilter("");
              }}
            >
              Clear filters
            </Button>
          )}
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => void load(false)} disabled={listLoading} className="ml-auto">
            Refresh
          </Button>
        </Toolbar>

        {reError && (
          <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setReError(null)}>
            {reError}
          </Alert>
        )}

        {listError ? (
          <ErrorState title="Couldn't load firmware" message={listError} />
        ) : firmware === null ? (
          <LoadingState label="Loading firmware…" />
        ) : firmware.length === 0 && !nextToken ? (
          <EmptyState
            icon={Microchip}
            title="No firmware uploaded yet"
            description="Firmware always belongs to a device: choose the device when you upload."
            action={
              <Button icon={Upload} onClick={() => setUploading(true)}>
                Upload firmware
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Microchip}
            title={filtering ? "No firmware matches these filters" : "No firmware in the files loaded so far"}
            description={nextToken ? "Load more to search further." : undefined}
          />
        ) : (
          <FirmwareTable
            firmware={visible}
            deviceNames={deviceNames}
            savingReIds={savingReIds}
            onReStatusChange={(f, next) => void changeReStatus(f, next)}
            onRetry={setRetryFirmware}
          />
        )}

        {nextToken && !listError && (
          <div className="px-5 py-3 border-t border-line text-center">
            <Button variant="secondary" size="sm" onClick={() => void load(true, nextToken)} disabled={listLoading}>
              {listLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>

      {uploading && (
        <FirmwareUploadDialog devices={devices ?? []} onClose={() => setUploading(false)} onUploaded={() => void load(false)} />
      )}
      {retryFirmware && (
        <FirmwareRetryDialog
          firmware={retryFirmware}
          onClose={() => setRetryFirmware(null)}
          onRetried={() => void load(false)}
        />
      )}
    </div>
  );
}
