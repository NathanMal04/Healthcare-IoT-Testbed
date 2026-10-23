"use client";

import { useState } from "react";
import { createDevice } from "@/lib/devices";
import type { Scope } from "@/lib/workspaces";
import { useScopeLock } from "@/context/WorkspaceContext";
import { Alert, Button, Dialog, inputClass, labelClass } from "@/app/components/ui";

/**
 * Registers a device in the current scope: personal, or in the selected
 * workspace (shared with its members). `onCreated` reloads the caller's list
 * before the dialog closes, as the dashboard did.
 */
export default function AddDeviceDialog({
  scope,
  onClose,
  onCreated,
}: {
  scope: Scope;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const workspaceId = scope.kind === "workspace" ? scope.workspaceId : undefined;
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // A device being created belongs to this scope; don't let the scope change under it.
  useScopeLock(submitting);

  const isFormValid = name.trim() !== "" && type.trim() !== "";

  function close() {
    if (submitting) return;
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedType = type.trim();
    if (!trimmedName || !trimmedType || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      // In a workspace the device is created there; otherwise it's personal.
      await createDevice({ name: trimmedName, type: trimmedType, ...(workspaceId ? { workspaceId } : {}) });
      await onCreated();
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create device");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title="Add device"
      subtitle={
        scope.kind === "workspace"
          ? `Register a new device in ${scope.name}, shared with its members`
          : "Register a new device for vulnerability analysis"
      }
      onClose={close}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="device-name">
            Device name
          </label>
          <input
            id="device-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            className={inputClass}
            placeholder="Philips IntelliVue MX800"
            autoFocus
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="device-type">
            Device type
          </label>
          <input
            id="device-type"
            type="text"
            value={type}
            onChange={(e) => setType(e.target.value)}
            disabled={submitting}
            className={inputClass}
            placeholder="Patient monitor"
          />
        </div>
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <div className="flex items-center gap-2 pt-2">
          <Button variant="secondary" onClick={close} disabled={submitting} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !isFormValid} className="flex-1">
            {submitting ? "Creating…" : "Add device"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
