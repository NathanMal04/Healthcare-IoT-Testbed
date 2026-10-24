"use client";

import { ARTIFACT_TYPES, ARTIFACT_TYPE_LABELS, type ArtifactType } from "@/lib/artifacts";

/**
 * The artifact categories as a row of chips: All, then one per type. Used by
 * the Artifacts page and a device's Artifacts tab. Not the Tabs component:
 * the device page's own tabs already use ids like "firmware".
 */
export default function ArtifactTypeChips({
  value,
  onChange,
  disabled = false,
  disabledTitle,
}: {
  value: ArtifactType | "";
  onChange: (value: ArtifactType | "") => void;
  disabled?: boolean;
  /** Shown on hover while disabled, to say why. */
  disabledTitle?: string;
}) {
  const options: { value: ArtifactType | ""; label: string }[] = [
    { value: "", label: "All" },
    ...ARTIFACT_TYPES.map((type) => ({ value: type, label: ARTIFACT_TYPE_LABELS[type].category })),
  ];
  return (
    <div role="group" aria-label="Artifact category" className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value || "all"}
            type="button"
            aria-pressed={selected}
            disabled={disabled && !selected}
            title={disabled && !selected ? disabledTitle : undefined}
            onClick={() => onChange(option.value)}
            className={`h-8 px-3 rounded-lg text-sm font-medium ring-1 ring-inset transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              selected
                ? "bg-brand-50 text-brand-700 ring-brand-100"
                : "bg-white text-slate-600 ring-line hover:text-slate-800 hover:ring-line-strong"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
