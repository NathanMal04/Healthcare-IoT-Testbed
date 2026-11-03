"use client";

import { canEditDevice, type Device, type ReverseEngineeringStatus } from "@/lib/devices";
import type { DeviceSort, DeviceSortKey, Figure } from "@/lib/deviceList";
import ReverseEngineeringStatusSelect from "@/app/components/ReverseEngineeringStatusSelect";
import ProfileAvatar from "@/app/components/images/ProfileAvatar";
import type { ImageUrls } from "@/app/components/images/useImageData";
import { DataTable, ReStatusBadge, formatDay, type Column } from "@/app/components/ui";
import { DeviceActionsMenu, FigureValue, roleLabel, type DeviceActionHandlers } from "./parts";

export interface DeviceViewProps {
  /** Already filtered and sorted by the page; both views show the same rows. */
  devices: Device[];
  figuresFor: (device: Device) => { cves: Figure; artifacts: Figure };
  urls: ImageUrls;
  onOpen: (device: Device) => void;
  handlers: DeviceActionHandlers;
}

export default function DeviceListView({
  devices,
  figuresFor,
  urls,
  onOpen,
  handlers,
  sort,
  onSortChange,
  savingStatusIds,
  onStatusChange,
}: DeviceViewProps & {
  sort: DeviceSort;
  onSortChange: (sort: DeviceSort) => void;
  savingStatusIds: ReadonlySet<string>;
  onStatusChange: (device: Device, next: ReverseEngineeringStatus) => void;
}) {
  const columns: Column<Device>[] = [
    {
      key: "name",
      header: "Device",
      sortable: true,
      cell: (device) => (
        <div className="flex items-center gap-3 min-w-0">
          <ProfileAvatar
            key={device.profileImageArtifactId ?? "none"}
            artifactId={device.profileImageArtifactId}
            urls={urls}
            alt={`Profile picture of ${device.name}`}
            size="md"
          />
          <div className="min-w-0">
            <p className="font-medium text-slate-900 break-words">{device.name}</p>
            {device.type && <p className="text-xs text-slate-500 truncate">{device.type}</p>}
          </div>
        </div>
      ),
    },
    {
      key: "manufacturer",
      header: "Manufacturer / model",
      sortable: true,
      hideBelow: "md",
      cell: (device) =>
        device.manufacturer || device.modelNumber ? (
          <div className="min-w-0">
            <p className="text-slate-700 break-words">{device.manufacturer ?? <span className="text-slate-400">—</span>}</p>
            {device.modelNumber && <p className="text-xs text-slate-500 font-mono break-words">{device.modelNumber}</p>}
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      key: "access",
      header: "Your access",
      hideBelow: "lg",
      className: "text-slate-600 whitespace-nowrap",
      cell: (device) => roleLabel(device.role),
    },
    {
      key: "status",
      header: "Reverse engineering",
      sortable: true,
      className: "whitespace-nowrap",
      cell: (device) =>
        canEditDevice(device) ? (
          <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <ReverseEngineeringStatusSelect
              value={device.reverseEngineeringStatus}
              saving={savingStatusIds.has(device.deviceId)}
              onChange={(next) => onStatusChange(device, next)}
              ariaLabel={`Reverse-engineering status for ${device.name}`}
            />
          </div>
        ) : (
          <ReStatusBadge status={device.reverseEngineeringStatus} />
        ),
    },
    {
      key: "cves",
      header: "CVEs",
      sortable: true,
      hideBelow: "sm",
      className: "text-slate-700",
      cell: (device) => <FigureValue figure={figuresFor(device).cves} label="Linked CVEs" />,
    },
    {
      key: "artifacts",
      header: "Artifacts",
      sortable: true,
      hideBelow: "md",
      className: "text-slate-700",
      cell: (device) => <FigureValue figure={figuresFor(device).artifacts} label="Artifacts" />,
    },
    {
      key: "updated",
      header: "Updated",
      sortable: true,
      hideBelow: "lg",
      className: "text-slate-500 whitespace-nowrap",
      cell: (device) => (device.updatedAt ? <time dateTime={device.updatedAt}>{formatDay(device.updatedAt)}</time> : "—"),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      headerClassName: "text-right",
      className: "text-right",
      cell: (device) => <DeviceActionsMenu device={device} handlers={handlers} />,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={devices}
      rowKey={(device) => device.deviceId}
      onRowClick={onOpen}
      rowLabel={(device) => `Open ${device.name}`}
      caption="Devices"
      sort={sort}
      onSortChange={(next) => onSortChange({ key: next.key as DeviceSortKey, direction: next.direction })}
      minWidth="36rem"
    />
  );
}

/** The list's placeholder while the devices load. */
export function DeviceListSkeleton() {
  return (
    <DataTable<Device>
      columns={["Device", "Manufacturer / model", "Reverse engineering", "CVEs", "Artifacts"].map((header, i) => ({
        key: String(i),
        header,
        hideBelow: i === 1 || i === 4 ? "md" : i === 3 ? "sm" : undefined,
        cell: () => null,
      }))}
      rows={[]}
      rowKey={(device) => device.deviceId}
      loading
      caption="Devices (loading)"
      minWidth="36rem"
    />
  );
}
