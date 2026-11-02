"use client";

import { useState } from "react";
import { Copy, CopyPlus, Undo2 } from "lucide-react";
import { docText, type NotebookDoc } from "@/lib/reNotebookDoc";
import type { NotebookEntry } from "@/lib/reNotebook";
import { Alert, Button, Dialog, formatDate } from "@/app/components/ui";
import NotebookDocView from "./NotebookDocView";

/**
 * Someone else saved the entry while it had unsaved changes here. Nothing has
 * been overwritten: their version is saved, this one is kept (in the editor
 * and as a local draft) until the user decides. There is deliberately no way
 * to overwrite their version from here:
 *
 * - Keep both: this version becomes a new entry ("… (my version)") next to
 *   it, and the entry shows their version.
 * - Use theirs: this version is discarded (after confirming).
 * - Copy my text: to paste it somewhere, then decide.
 */
export default function ConflictDialog({
  title,
  mine,
  theirs,
  theirEntry,
  onKeepBoth,
  onUseTheirs,
  onClose,
}: {
  title: string;
  mine: NotebookDoc;
  theirs: NotebookDoc;
  theirEntry: NotebookEntry;
  /** Saves `mine` as a new entry; resolves false (with the error shown) if it couldn't. */
  onKeepBoth: () => Promise<string | null>;
  onUseTheirs: () => void;
  onClose: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const who = theirEntry.contentUpdatedByName ?? theirEntry.updatedByName ?? "Someone else";
  const when = formatDate(theirEntry.contentUpdatedAt ?? theirEntry.updatedAt);

  async function keepBoth() {
    setWorking(true);
    setError(null);
    const failure = await onKeepBoth();
    setWorking(false);
    if (failure) setError(failure);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(docText(mine));
      setCopied(true);
    } catch {
      setError("Couldn't copy to the clipboard. Select the text in “Your unsaved version” and copy it instead.");
    }
  }

  return (
    <Dialog
      title="This entry was changed by someone else"
      subtitle={title}
      size="full"
      onClose={() => {
        if (!working) onClose();
      }}
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {who} saved a new version on {when} while you were editing. Your changes have <strong>not</strong> been saved and
          nothing was overwritten. Your version is kept on this browser until you choose what to do.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <section aria-label="Your unsaved version" className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Your unsaved version</h3>
            <div className="max-h-[45vh] overflow-auto rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-3">
              <NotebookDocView doc={mine} label="Your unsaved version" />
            </div>
          </section>
          <section aria-label="Their saved version" className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
              Saved version by {who}
            </h3>
            <div className="max-h-[45vh] overflow-auto rounded-lg border border-line bg-white px-4 py-3">
              <NotebookDocView doc={theirs} label={`Saved version by ${who}`} />
            </div>
          </section>
        </div>
        {error && <Alert>{error}</Alert>}
        {copied && <Alert tone="success">Your version was copied to the clipboard as plain text.</Alert>}
        {confirmDiscard ? (
          <Alert
            tone="warning"
            action={
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="secondary" onClick={() => setConfirmDiscard(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" onClick={onUseTheirs}>
                  Discard my changes
                </Button>
              </div>
            }
          >
            Your unsaved changes will be lost. Their version stays as it is.
          </Alert>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" icon={Copy} onClick={() => void copy()} disabled={working}>
              Copy my text
            </Button>
            <Button variant="secondary" icon={Undo2} onClick={() => setConfirmDiscard(true)} disabled={working}>
              Use their version
            </Button>
            <Button icon={CopyPlus} onClick={() => void keepBoth()} disabled={working}>
              {working ? "Saving your version…" : "Keep both (save mine as a new entry)"}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
