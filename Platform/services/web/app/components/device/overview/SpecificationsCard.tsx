"use client";

import { Pencil } from "lucide-react";
import type { Device } from "@/lib/devices";
import { formatDay } from "@/lib/format";
import { Button, Card, CardHeader } from "@/app/components/ui";

/** The specification fields, in reading order; the reported firmware version is the device's own claim. */
const FIELDS: { key: keyof Device; label: string }[] = [
  { key: "manufacturer", label: "Manufacturer" },
  { key: "modelNumber", label: "Model" },
  { key: "type", label: "Device type" },
  { key: "chipset", label: "Chipset" },
  { key: "serialNumber", label: "Serial number" },
  { key: "hardwareRevision", label: "Hardware revision" },
  { key: "firmwareVersion", label: "Reported firmware version" },
];

/**
 * What is recorded about the device. Every field is listed, so a missing one
 * reads "Not recorded" instead of disappearing; editors can fill them in with
 * the existing edit dialog.
 */
export default function SpecificationsCard({
  device,
  canEdit,
  onEdit,
}: {
  device: Device;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const missing = FIELDS.filter(({ key }) => !device[key]).length + (device.description ? 0 : 1);
  const dates: [string, string | undefined][] = [
    ["Added", device.createdAt],
    ["Last updated", device.updatedAt],
  ];
  return (
    <Card>
      <CardHeader
        title="Specifications"
        description={missing > 0 ? `${missing} of ${FIELDS.length + 1} details not recorded` : undefined}
        actions={
          canEdit ? (
            <Button variant="secondary" size="sm" icon={Pencil} onClick={onEdit}>
              Edit details
            </Button>
          ) : undefined
        }
      />
      <dl className="divide-y divide-line">
        {FIELDS.map(({ key, label }) => (
          <Row key={key} term={label} value={device[key] as string | undefined} />
        ))}
        <Row term="Description" value={device.description} multiline />
        {dates.map(([term, value]) => (value ? <Row key={term} term={term} value={formatDay(value)} /> : null))}
      </dl>
    </Card>
  );
}

/** One fact: the term above its value on narrow screens, beside it from `sm`. */
function Row({ term, value, multiline }: { term: string; value?: string; multiline?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 px-5 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-meta text-slate-500 sm:pt-px">{term}</dt>
      <dd className={`min-w-0 break-words text-sm ${value ? "text-slate-900" : "text-slate-400"} ${multiline ? "whitespace-pre-wrap" : ""}`}>
        {value || "Not recorded"}
      </dd>
    </div>
  );
}
