"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/context/WorkspaceContext";
import { getDevices, type Device } from "@/lib/devices";
import { cveHref } from "@/lib/routes";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import { cveErrorMessage, listCves, type Cve, type CveSummary } from "@/lib/cves";
import { AddCveDialog, DeleteCveDialog } from "@/app/components/CveDialogs";
import CveList from "@/app/components/CveList";
import { Eye, Link2, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  LoadingState,
  PageHeader,
  RowActionsMenu,
  useRequireUser,
} from "@/app/components/ui";

export default function VulnerabilitiesPage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  // Keyed on the scope: switching remounts the view, so the list, filters and
  // open dialogs reset, and a late response for the previous scope lands in
  // the unmounted view instead of this one.
  return <VulnerabilitiesView key={scopeKey(scope)} />;
}

function VulnerabilitiesView() {
  const ready = useRequireUser();
  const router = useRouter();
  const { scope, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);

  const [cves, setCves] = useState<CveSummary[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<CveSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Only the latest load may update the page (e.g. Refresh overtaking the first load).
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    const isCurrent = () => isMountedRef.current && loadId === loadIdRef.current;
    setListLoading(true);
    setListError(null);
    // The CVEs and the devices that name their links come from the same scope.
    const [cveResult, deviceResult] = await Promise.allSettled([listCves(workspaceId), getDevices(workspaceId)]);
    if (!isCurrent()) return;
    if (cveResult.status === "fulfilled") {
      setCves(cveResult.value);
    } else {
      setListError(cveErrorMessage(cveResult.reason, "Couldn't load CVEs"));
      if (workspaceId && isWorkspaceUnavailable(cveResult.reason)) reportWorkspaceUnavailable();
    }
    if (deviceResult.status === "fulfilled") {
      setDevices(deviceResult.value);
      setDevicesError(null);
    } else {
      setDevices(null);
      setDevicesError("Device names couldn't be loaded.");
    }
    setListLoading(false);
  }, [workspaceId, reportWorkspaceUnavailable]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const deviceNames = useMemo(() => new Map((devices ?? []).map((d) => [d.deviceId, d.name])), [devices]);

  const upsert = useCallback((cve: Cve) => {
    setCves((current) => {
      if (!current) return [cve];
      return current.some((c) => c.cveRecordId === cve.cveRecordId)
        ? current.map((c) => (c.cveRecordId === cve.cveRecordId ? cve : c))
        : [cve, ...current];
    });
  }, []);

  const removeRow = useCallback((cveRecordId: string) => {
    setCves((current) => current?.filter((c) => c.cveRecordId !== cveRecordId) ?? current);
    setDeleting(null);
  }, []);

  if (!ready) return null;

  const scopeName = scope.kind === "workspace" ? scope.name : "Personal";
  return (
    <div>
      <PageHeader
        title="Vulnerabilities (CVE)"
        description="Known vulnerabilities recorded against your devices"
        scope={scope}
        actions={
          <Button icon={Plus} onClick={() => setAdding(true)}>
            Add CVE
          </Button>
        }
      />

      {notice && (
        <Alert tone="warning" onDismiss={() => setNotice(null)} className="mb-4">
          {notice}
        </Alert>
      )}

      <Card className="overflow-hidden">
        <CveList
          cves={cves}
          error={listError}
          devices={devices}
          devicesError={devicesError}
          refreshing={listLoading}
          onRefresh={() => void load()}
          // Each CVE opens on its own page.
          openHref={(cve) => cveHref(cve.cveRecordId)}
          actions={(cve) => (
            <RowActionsMenu
              label={`Actions for ${cve.cveId}`}
              actions={[
                { label: "View details", icon: Eye, href: cveHref(cve.cveRecordId) },
                { label: "Edit CVE", icon: Pencil, href: cveHref(cve.cveRecordId, undefined, { edit: true }) },
                { label: "Link devices", icon: Link2, href: cveHref(cve.cveRecordId, "devices") },
                {
                  label: "Delete CVE",
                  icon: Trash2,
                  danger: true,
                  onSelect: () => {
                    setNotice(null);
                    setDeleting(cve);
                  },
                },
              ]}
            />
          )}
          empty={
            <EmptyState
              icon={ShieldAlert}
              title={`No CVEs recorded in ${scopeName} yet`}
              description="Record a known vulnerability and link it to the devices it affects."
              action={
                <Button icon={Plus} onClick={() => setAdding(true)}>
                  Add CVE
                </Button>
              }
            />
          }
        />
      </Card>

      {adding && (
        <AddCveDialog
          scope={scope}
          devices={devices}
          deviceNames={deviceNames}
          onClose={() => setAdding(false)}
          onSaved={upsert}
          onOpenExisting={(id) => router.push(cveHref(id))}
        />
      )}

      {deleting && (
        <DeleteCveDialog
          cve={deleting}
          scope={scope}
          onCancel={() => setDeleting(null)}
          onDeleted={removeRow}
          onGone={(id, message) => {
            removeRow(id);
            setNotice(message);
          }}
          onRefreshed={upsert}
        />
      )}

    </div>
  );
}
