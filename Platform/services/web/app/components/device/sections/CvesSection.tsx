"use client";

import { useState } from "react";
import { Eye, Link2, ShieldAlert, Unlink } from "lucide-react";
import type { Device } from "@/lib/devices";
import { cveErrorMessage, isNotFound, unlinkCveDevice, type Cve, type CveSummary } from "@/lib/cves";
import { deviceHref } from "@/lib/routes";
import type { Scope } from "@/lib/workspaces";
import { useScopeLock } from "@/context/WorkspaceContext";
import CveList from "@/app/components/CveList";
import CveLinkExplorer from "@/app/components/CveLinkExplorer";
import { Alert, Button, ButtonLink, Card, CardHeader, EmptyState, RowActionsMenu } from "@/app/components/ui";

/** The CVEs linked to the device: open, link and unlink them. */
export default function CvesSection({
  device,
  scope,
  allCves,
  deviceCves,
  error,
  devices,
  devicesError,
  refreshing,
  onRefresh,
  onChanged,
  onRemoved,
}: {
  device: Device;
  scope: Scope;
  allCves: CveSummary[] | null;
  deviceCves: CveSummary[];
  error: string | null;
  devices: Device[] | null;
  devicesError: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onChanged: (cve: Cve) => void;
  onRemoved: (cveRecordId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [exploring, setExploring] = useState(false);

  // A link change belongs to this scope; keep it from changing mid-request.
  useScopeLock(busy !== null);

  function openExplorer() {
    setActionError(null);
    setLinkNotice(null);
    setExploring(true);
  }

  // The existing association endpoints; "changed: false" (already linked or
  // already unlinked) counts as success.
  async function unlink(cve: CveSummary) {
    if (busy) return;
    setBusy(`unlink:${cve.cveRecordId}`);
    setActionError(null);
    try {
      onChanged((await unlinkCveDevice(cve.cveRecordId, device.deviceId)).cve);
    } catch (err) {
      if (isNotFound(err)) {
        onRemoved(cve.cveRecordId);
        setActionError(`${cve.cveId} no longer exists, or you no longer have access to it.`);
      } else {
        setActionError(cveErrorMessage(err, "Couldn't unlink the CVE"));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Linked vulnerabilities"
        description={`CVEs recorded in ${scope.kind === "workspace" ? scope.name : "Personal"} that affect this device`}
        actions={
          <>
            <ButtonLink href="/vulnerabilities" variant="secondary" size="sm">
              All vulnerabilities
            </ButtonLink>
            <Button size="sm" icon={Link2} onClick={openExplorer} disabled={busy !== null}>
              Link CVEs
            </Button>
          </>
        }
      />
      {linkNotice && (
        <Alert tone="success" className="mx-5 mt-3" onDismiss={() => setLinkNotice(null)}>
          {linkNotice}
        </Alert>
      )}
      {actionError && (
        <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      {/* Only this device's CVEs: search and filters narrow them, never widen. */}
      <CveList
        cves={allCves === null ? null : deviceCves}
        error={error}
        devices={devices}
        devicesError={devicesError}
        refreshing={refreshing}
        onRefresh={onRefresh}
        openHref={(cve) => deviceHref(device.deviceId, "cves", { cve: cve.cveRecordId })}
        actions={(cve) =>
          busy === `unlink:${cve.cveRecordId}` ? (
            <span className="text-xs text-slate-500 whitespace-nowrap">Unlinking…</span>
          ) : (
            <RowActionsMenu
              label={`Actions for ${cve.cveId}`}
              disabled={busy !== null}
              actions={[
                { label: "View details", icon: Eye, href: deviceHref(device.deviceId, "cves", { cve: cve.cveRecordId }) },
                { label: "Unlink from device", icon: Unlink, onSelect: () => void unlink(cve) },
              ]}
            />
          )
        }
        empty={
          <EmptyState
            icon={ShieldAlert}
            title="No CVEs linked to this device"
            description="Choose from the CVEs recorded in this scope, or record a new one on Vulnerabilities."
            action={
              <Button size="sm" icon={Link2} onClick={openExplorer}>
                Link CVEs
              </Button>
            }
          />
        }
      />

      {exploring && (
        <CveLinkExplorer
          device={device}
          cves={allCves}
          error={error}
          devices={devices}
          devicesError={devicesError}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onLinked={(linked) => linked.forEach(onChanged)}
          onDone={(count) => {
            setExploring(false);
            setLinkNotice(`Linked ${count} CVE${count === 1 ? "" : "s"} to ${device.name}.`);
          }}
          onClose={() => setExploring(false)}
        />
      )}
    </Card>
  );
}
