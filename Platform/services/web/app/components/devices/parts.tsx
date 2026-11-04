"use client";

import { BookOpen, Eye, Images, Microchip, Pencil, ShieldAlert, Upload } from "lucide-react";
import { canEditDevice, type Device } from "@/lib/devices";
import type { Figure } from "@/lib/deviceList";
import { deviceHref, notebookHref } from "@/lib/routes";
import { RowActionsMenu, Skeleton } from "@/app/components/ui";

/** What the Devices page does when an action that isn't a link is chosen. */
export interface DeviceActionHandlers {
  onEdit: (device: Device) => void;
  onUploadFirmware: (device: Device) => void;
}

/**
 * The ⋮ menu for a device, the same in the list and the grid. Links go to
 * the existing Device Details sections; "Edit details" and "Upload firmware"
 * are offered only to those who may edit (the API enforces the same rule).
 */
export function DeviceActionsMenu({ device, handlers }: { device: Device; handlers: DeviceActionHandlers }) {
  return (
    <RowActionsMenu
      label={`Actions for ${device.name}`}
      actions={[
        { label: "View details", icon: Eye, href: deviceHref(device.deviceId) },
        canEditDevice(device) && { label: "Edit details", icon: Pencil, onSelect: () => handlers.onEdit(device) },
        { label: "View firmware", icon: Microchip, href: deviceHref(device.deviceId, "firmware") },
        { label: "View images", icon: Images, href: deviceHref(device.deviceId, "images") },
        { label: "View CVEs", icon: ShieldAlert, href: deviceHref(device.deviceId, "cves") },
        { label: "Open RE Notebook", icon: BookOpen, href: notebookHref(device.deviceId) },
        canEditDevice(device) && {
          label: "Upload firmware",
          icon: Upload,
          onSelect: () => handlers.onUploadFirmware(device),
        },
      ]}
    />
  );
}

/**
 * A count: the value, a placeholder while it loads, or a dash when it
 * couldn't be loaded. `label` names it for screen readers ("CVEs linked").
 */
export function FigureValue({ figure, label, className = "" }: { figure: Figure; label: string; className?: string }) {
  if (figure.state === "loading") {
    return (
      <span className={`inline-flex ${className}`}>
        <Skeleton className="h-3.5 w-6" />
        <span className="sr-only">{label}: loading</span>
      </span>
    );
  }
  if (figure.state === "unavailable") {
    return (
      <span className={`text-slate-400 ${className}`} title="Couldn't be loaded">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{label}: not available</span>
      </span>
    );
  }
  return (
    <span className={`tabular-nums ${className}`} title={`${label}: ${figure.description}`}>
      <span aria-hidden="true">{figure.text}</span>
      <span className="sr-only">
        {label}: {figure.description}
      </span>
    </span>
  );
}

/** "Owner", "Member", … (the API's role names, capitalised). */
export function roleLabel(role: string | undefined): string {
  if (!role) return "—";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** "Infusion pump · Philips MX800": whichever of type, manufacturer and model a device has. */
export function deviceSubtitle(device: Pick<Device, "manufacturer" | "modelNumber">): string | null {
  const make = [device.manufacturer, device.modelNumber].filter(Boolean).join(" ");
  return make || null;
}
