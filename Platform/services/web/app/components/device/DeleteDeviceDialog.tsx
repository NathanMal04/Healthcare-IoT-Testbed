"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  deleteDevice,
  deletionConfirmed,
  deletionSummary,
  getDeviceDeletionPreview,
  type Device,
  type DeviceDeletionPreview,
  type DeviceDeletionResult,
} from "@/lib/devices";
import type { Scope } from "@/lib/workspaces";
import { useScopeLock } from "@/context/WorkspaceContext";
import { Alert, Button, Dialog, LoadingState, inputClass } from "@/app/components/ui";

function scopeName(scope: Scope): string {
  return scope.kind === "workspace" ? `the ${scope.name} workspace` : "Personal";
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Confirms and permanently deletes a device: shows what will be deleted and
 * what is only unlinked (shared files, CVE records, runs), and enables
 * Delete only once the device's name is typed. Escape and the backdrop are
 * ignored while the deletion runs.
 */
export default function DeleteDeviceDialog({
  device,
  scope,
  onCancel,
  onDeleted,
}: {
  device: Device;
  scope: Scope;
  onCancel: () => void;
  /** The device is gone (`cleanupPending` if some cleanup finishes in the background). */
  onDeleted: (result: Pick<DeviceDeletionResult, "cleanupPending"> & { alreadyGone?: boolean }) => void;
}) {
  const inputId = useId();
  const hintId = useId();
  const [preview, setPreview] = useState<DeviceDeletionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useScopeLock(busy);

  const loadPreview = useCallback(() => {
    let active = true;
    setPreview(null);
    setPreviewError(null);
    getDeviceDeletionPreview(device.deviceId).then(
      (found) => active && setPreview(found),
      (err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) {
          onDeleted({ cleanupPending: false, alreadyGone: true });
          return;
        }
        setPreviewError(
          err instanceof ApiError && err.status === 403
            ? "You don't have permission to delete this device."
            : errorMessage(err, "Couldn't load what this device contains")
        );
      }
    );
    return () => {
      active = false;
    };
  }, [device.deviceId, onDeleted]);

  useEffect(() => loadPreview(), [loadPreview]);

  const name = preview?.name ?? device.name;
  const confirmed = deletionConfirmed(typed, name);
  const summary = preview ? deletionSummary(preview.resources) : null;

  async function remove() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteDevice(device.deviceId, typed.trim());
      onDeleted({ cleanupPending: result.cleanupPending });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        onDeleted({ cleanupPending: false, alreadyGone: true });
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setError("This device changed while you were deleting it (it may have been renamed). Check the details and confirm again.");
        setTyped("");
        loadPreview();
      } else if (err instanceof ApiError && err.status === 403) {
        setError("You don't have permission to delete this device.");
      } else {
        setError(errorMessage(err, "Couldn't delete the device. Nothing was changed; try again."));
      }
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Delete ${name}?`} onClose={() => !busy && onCancel()} wide>
      <form
        className="space-y-4 text-sm text-slate-700"
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <Alert tone="error">
          <span className="inline-flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              This permanently deletes <span className="font-semibold break-words">{name}</span> from {scopeName(scope)}
              . It can&apos;t be undone.
            </span>
          </span>
        </Alert>

        {previewError ? (
          <Alert tone="error">
            {previewError}{" "}
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => loadPreview()}>
              Try again
            </button>
          </Alert>
        ) : !summary ? (
          <LoadingState label="Checking what this device contains…" />
        ) : (
          <div className="space-y-3" data-testid="deletion-summary">
            <div>
              <p className="font-medium text-slate-900">Deleted with the device</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>The device record and its details</li>
                {summary.deleted.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            {summary.kept.length > 0 && (
              <div>
                <p className="font-medium text-slate-900">Unlinked, not deleted</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
                  {summary.kept.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div>
          <label htmlFor={inputId} className="block font-medium text-slate-900">
            Type <span className="font-mono font-semibold break-all">{name}</span> to confirm
          </label>
          <input
            id={inputId}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy || !summary}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={hintId}
            className={`mt-1.5 ${inputClass}`}
          />
          <p id={hintId} className="mt-1 text-xs text-slate-500">
            {typed && !confirmed ? "That doesn't match the device's name yet." : "The name must match exactly."}
          </p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}
        {busy && (
          <p role="status" className="text-slate-500">
            Deleting the device and its files… Keep this page open.
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!confirmed || busy || !summary}>
            {busy ? "Deleting…" : "Delete device"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
