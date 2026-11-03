"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { updateDeviceReverseEngineeringStatus, type Device, type ReverseEngineeringStatus } from "@/lib/devices";
import type { Artifact } from "@/lib/artifacts";
import { firmwareBreakdown } from "@/lib/deviceOverview";
import { REVERSE_ENGINEERING_STATUSES, REVERSE_ENGINEERING_STATUS_LABELS } from "@/lib/reverseEngineering";
import ReverseEngineeringStatusSelect from "@/app/components/ReverseEngineeringStatusSelect";
import { Alert, Card, CardHeader, ReStatusBadge, SkeletonText, focusRing } from "@/app/components/ui";

const SEGMENT: Record<ReverseEngineeringStatus, string> = {
  not_started: "bg-slate-300",
  in_progress: "bg-warning-500",
  complete: "bg-success-500",
};

/**
 * The device's reverse-engineering status (editable by those who may edit
 * the device; read-only for viewers, whose change the backend refuses), and how
 * its firmware versions stand: how many are not started, in progress and
 * complete, from the firmware records themselves. No overall percentage:
 * the backend doesn't define one.
 */
export default function ResearchStatusCard({
  device,
  canEdit,
  firmware,
  firmwareError,
  firmwareHref,
  onDeviceChange,
}: {
  device: Device;
  canEdit: boolean;
  firmware: Artifact[] | null;
  firmwareError: string | null;
  firmwareHref: string;
  /** Applies a change to the latest device state, not to this render's copy. */
  onDeviceChange: (update: (current: Device) => Device) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  // The select shows the saved value, which only changes once the API has
  // saved the new one; on failure it keeps showing the saved one.
  async function handleStatusChange(next: ReverseEngineeringStatus) {
    if (next === device.reverseEngineeringStatus || saving) return;
    setStatusError(null);
    setSaving(true);
    try {
      const updated = await updateDeviceReverseEngineeringStatus(device.deviceId, next);
      // Only the status is changed, on the latest device: anything saved while
      // this request ran (e.g. the profile picture) is kept.
      onDeviceChange((current) => ({ ...current, reverseEngineeringStatus: updated.reverseEngineeringStatus }));
    } catch (err) {
      setStatusError(`Couldn't update ${device.name}: ${err instanceof Error ? err.message : "Failed to update status"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Research status" />
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800">Device</p>
            <p className="text-meta text-slate-500">How far the reverse engineering of this device has progressed.</p>
          </div>
          <div className="flex items-center">
            {canEdit ? (
              <ReverseEngineeringStatusSelect
                value={device.reverseEngineeringStatus}
                saving={saving}
                onChange={(next) => void handleStatusChange(next)}
                ariaLabel={`Reverse-engineering status for ${device.name}`}
              />
            ) : (
              <span className="inline-flex items-center">
                <span className="sr-only">Reverse-engineering status: </span>
                <ReStatusBadge status={device.reverseEngineeringStatus} />
              </span>
            )}
          </div>
        </div>
        {statusError && <Alert tone="error">{statusError}</Alert>}

        <div className="border-t border-line pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-slate-800" id="overview-firmware-progress">
              Firmware investigation
            </p>
            <Link
              href={firmwareHref}
              scroll={false}
              className={`inline-flex items-center gap-1 rounded-md text-meta font-medium text-brand-700 hover:text-brand-800 ${focusRing}`}
            >
              View firmware
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
          <FirmwareProgress firmware={firmware} error={firmwareError} />
        </div>
      </div>
    </Card>
  );
}

function FirmwareProgress({ firmware, error }: { firmware: Artifact[] | null; error: string | null }) {
  if (error) return <p className="mt-2 text-meta text-danger-700">Couldn&apos;t load firmware: {error}</p>;
  if (!firmware) return <SkeletonText lines={2} className="mt-3" />;
  if (firmware.length === 0) return <p className="mt-2 text-meta text-slate-500">No firmware uploaded yet.</p>;

  const { total, counts, notReady } = firmwareBreakdown(firmware);
  return (
    <div className="mt-2 space-y-3">
      <p className="text-meta text-slate-600">
        Reverse engineering complete for {counts.complete} of {total} firmware {total === 1 ? "version" : "versions"}
      </p>
      {/* The proportions, drawn; the counts below say the same in words. */}
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
        {REVERSE_ENGINEERING_STATUSES.map((status) =>
          counts[status] > 0 ? (
            <span key={status} className={SEGMENT[status]} style={{ flexGrow: counts[status], flexBasis: 0 }} />
          ) : null
        )}
      </div>
      {/* Reverse-engineering progress per version; upload readiness is separate (below). */}
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5" aria-labelledby="overview-firmware-progress">
        {REVERSE_ENGINEERING_STATUSES.map((status) => (
          <li key={status} className="inline-flex items-center gap-1.5 text-meta text-slate-600">
            <span className={`h-2 w-2 rounded-full ${SEGMENT[status]}`} aria-hidden="true" />
            {REVERSE_ENGINEERING_STATUS_LABELS[status]}
            <span className="font-semibold tabular-nums text-slate-900">{counts[status]}</span>
          </li>
        ))}
      </ul>
      {notReady > 0 && (
        <p className="text-meta text-slate-500">
          Upload status: {notReady} {notReady === 1 ? "version isn't" : "versions aren't"} ready yet (pending, verifying or
          failed).
        </p>
      )}
    </div>
  );
}
