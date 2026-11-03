"use client";

import { useEffect, useState } from "react";
import { Cpu, FolderArchive, Microchip, ShieldAlert } from "lucide-react";
import {
  DEVICE_DETAIL_FIELDS,
  updateDeviceReverseEngineeringStatus,
  type Device,
  type ReverseEngineeringStatus,
} from "@/lib/devices";
import { listDeviceArtifacts, type Artifact } from "@/lib/artifacts";
import { countLabel } from "@/lib/dashboard";
import type { DeviceSection } from "@/lib/deviceView";
import type { Scope } from "@/lib/workspaces";
import ReverseEngineeringStatusSelect from "@/app/components/ReverseEngineeringStatusSelect";
import { Alert, Card, CardHeader, ScopeLabel } from "@/app/components/ui";

/** The device's details, its reverse-engineering status, and counts that open their sections. */
export default function OverviewSection({
  device,
  scope,
  firmware,
  cveCount,
  onDeviceChange,
  onOpenSection,
}: {
  device: Device;
  scope: Scope;
  firmware: Artifact[] | null;
  cveCount: number | null;
  /** Applies a change to the latest device state, not to this render's copy. */
  onDeviceChange: (update: (current: Device) => Device) => void;
  onOpenSection: (section: DeviceSection) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [artifactCount, setArtifactCount] = useState<{ count: number; hasMore: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    listDeviceArtifacts(device.deviceId, { limit: 100 })
      .then((page) => {
        if (active) setArtifactCount({ count: page.artifacts.length, hasMore: !!page.nextToken });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [device.deviceId]);

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

  // Optional details are shown only when the device has them.
  const facts: [string, React.ReactNode][] = [
    ["Name", device.name],
    ["Type", device.type || <span key="type" className="text-slate-300">—</span>],
    ...DEVICE_DETAIL_FIELDS.filter(({ key }) => device[key]).map(({ key, label }): [string, React.ReactNode] => [
      label,
      key === "description" ? <span key={key} className="whitespace-pre-wrap">{device[key]}</span> : device[key],
    ]),
    ["Scope", <ScopeLabel key="scope" scope={scope} />],
    ["Your access", <span key="role" className="capitalize">{device.role}</span>],
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2">
        <CardHeader title="Device information" />
        <dl className="divide-y divide-line">
          {facts.map(([label, value]) => (
            <div key={label} className="px-5 py-3 grid grid-cols-3 gap-4 text-sm">
              <dt className="text-slate-500">{label}</dt>
              <dd className="col-span-2 text-slate-900 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card>
        <CardHeader title="Reverse-engineering status" />
        <div className="p-5 space-y-3">
          <ReverseEngineeringStatusSelect
            value={device.reverseEngineeringStatus}
            saving={saving}
            onChange={(next) => void handleStatusChange(next)}
            ariaLabel={`Reverse-engineering status for ${device.name}`}
          />
          <p className="text-xs text-slate-500">Track how far the reverse engineering of this device has progressed.</p>
          {statusError && <Alert tone="error">{statusError}</Alert>}
        </div>
      </Card>

      <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <CountTile icon={Microchip} label="Firmware versions" value={firmware ? String(firmware.length) : "…"} onClick={() => onOpenSection("firmware")} />
        <CountTile
          icon={FolderArchive}
          label="Artifacts"
          value={artifactCount ? countLabel(artifactCount.count, artifactCount.hasMore) : "…"}
          onClick={() => onOpenSection("artifacts")}
        />
        <CountTile icon={ShieldAlert} label="Linked CVEs" value={cveCount === null ? "…" : String(cveCount)} onClick={() => onOpenSection("cves")} />
      </div>
    </div>
  );
}

function CountTile({
  icon: Icon,
  label,
  value,
  onClick,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-white rounded-xl border border-line shadow-card p-4 hover:border-line-strong hover:shadow-md transition-shadow"
    >
      <span className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <Icon className="h-4 w-4 text-brand-600" aria-hidden="true" />
      </span>
      <span className="block text-2xl font-semibold text-slate-900 mt-2 tabular-nums">{value}</span>
    </button>
  );
}
