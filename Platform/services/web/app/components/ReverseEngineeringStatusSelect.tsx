"use client";

import {
  REVERSE_ENGINEERING_STATUSES,
  REVERSE_ENGINEERING_STATUS_LABELS,
  REVERSE_ENGINEERING_STATUS_STYLES,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";

interface ReverseEngineeringStatusSelectProps {
  /** The saved value; the parent only changes it once a save succeeds. */
  value: ReverseEngineeringStatus;
  saving: boolean;
  onChange: (next: ReverseEngineeringStatus) => void;
  ariaLabel: string;
}

export default function ReverseEngineeringStatusSelect({
  value,
  saving,
  onChange,
  ariaLabel,
}: ReverseEngineeringStatusSelectProps) {
  return (
    <>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ReverseEngineeringStatus)}
        disabled={saving}
        aria-label={ariaLabel}
        className={`text-xs font-medium border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 ${REVERSE_ENGINEERING_STATUS_STYLES[value]}`}
      >
        {REVERSE_ENGINEERING_STATUSES.map((status) => (
          <option key={status} value={status}>
            {REVERSE_ENGINEERING_STATUS_LABELS[status]}
          </option>
        ))}
      </select>
      {saving && <span className="ml-2 text-xs text-slate-400">Saving…</span>}
    </>
  );
}
