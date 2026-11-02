"use client";

import { useState } from "react";
import type { Notebook, NotebookEntry } from "@/lib/reNotebook";
import { Alert, Button, Dialog, inputClass, labelClass, selectClass } from "@/app/components/ui";

/** Name a new section or entry, or rename one. */
export function TitleDialog({
  title,
  label,
  initial = "",
  submitLabel,
  maxLength,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  maxLength: number;
  /** Resolves true when done (the dialog then closes). */
  onSubmit: (value: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const trimmed = value.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || saving) return;
    setSaving(true);
    const done = await onSubmit(trimmed);
    setSaving(false);
    if (done) onClose();
  }

  return (
    <Dialog title={title} onClose={() => !saving && onClose()}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="re-notebook-title" className={labelClass}>
            {label}
          </label>
          <input
            id="re-notebook-title"
            autoFocus
            className={inputClass}
            value={value}
            maxLength={maxLength}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={!trimmed || saving || trimmed === initial.trim()}>
            {saving ? "Saving…" : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Confirms a destructive action. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [working, setWorking] = useState(false);
  return (
    <Dialog title={title} onClose={() => !working && onClose()}>
      <div className="space-y-4">
        <div className="text-sm text-slate-600 space-y-2">{children}</div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              const done = await onConfirm();
              setWorking(false);
              if (done) onClose();
            }}
          >
            {working ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Moves an entry to the end of another section. */
export function MoveEntryDialog({
  notebook,
  entry,
  onMove,
  onClose,
}: {
  notebook: Notebook;
  entry: NotebookEntry;
  onMove: (targetSectionId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const targets = notebook.sections.filter((s) => s.sectionId !== entry.sectionId);
  const [target, setTarget] = useState(targets[0]?.sectionId ?? "");
  const [working, setWorking] = useState(false);
  const full = targets.find((s) => s.sectionId === target)?.entries.length === notebook.limits.entriesPerSection;

  return (
    <Dialog title="Move entry" subtitle={entry.title} onClose={() => !working && onClose()}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!target || working) return;
          setWorking(true);
          const done = await onMove(target);
          setWorking(false);
          if (done) onClose();
        }}
      >
        {targets.length ? (
          <div>
            <label htmlFor="re-notebook-move-target" className={labelClass}>
              Move to section
            </label>
            <select
              id="re-notebook-move-target"
              className={`${selectClass} w-full`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((s) => (
                <option key={s.sectionId} value={s.sectionId}>
                  {s.title}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-slate-500">The entry is added at the end of that section.</p>
          </div>
        ) : (
          <Alert tone="info">There&apos;s no other section to move it to. Add a section first.</Alert>
        )}
        {full && <Alert tone="warning">That section is full ({notebook.limits.entriesPerSection} entries).</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button type="submit" disabled={!target || working || full}>
            {working ? "Moving…" : "Move"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
