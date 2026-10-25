"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { createDevice, deviceFormError, emptyDeviceForm, newDeviceBody, type DeviceForm } from "@/lib/devices";
import type { Scope } from "@/lib/workspaces";
import { useScopeLock } from "@/context/WorkspaceContext";
import { Alert, Button, Dialog } from "@/app/components/ui";
import { DeviceDetailFields, DeviceIdentityFields } from "@/app/components/DeviceFormFields";

/**
 * Registers a device in the current scope: personal, or in the selected
 * workspace (shared with its members). `onCreated` reloads the caller's list
 * before the dialog closes, as the dashboard did.
 *
 * Only the name and type are required; the details under "Additional
 * Details" are optional, and any left empty are not sent.
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
  const [form, setForm] = useState<DeviceForm>(emptyDeviceForm);
  const [showDetails, setShowDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // A device being created belongs to this scope; don't let the scope change under it.
  useScopeLock(submitting);

  const isFormValid = deviceFormError(form) === null;

  function setField(key: keyof DeviceForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function close() {
    if (submitting) return;
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isFormValid || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      // In a workspace the device is created there; otherwise it's personal.
      await createDevice(newDeviceBody(form, workspaceId));
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
      size={showDetails ? "lg" : "sm"}
      onClose={close}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <DeviceIdentityFields form={form} onChange={setField} disabled={submitting} autoFocus />
        <div className="border-t border-line pt-3">
          <button
            type="button"
            onClick={() => setShowDetails((open) => !open)}
            aria-expanded={showDetails}
            aria-controls="add-device-details"
            className="flex w-full items-center justify-between text-sm font-medium text-slate-700 hover:text-slate-900"
          >
            Additional Details (Optional)
            <ChevronDown
              className={`h-4 w-4 text-slate-400 transition-transform ${showDetails ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>
          {/* Kept mounted while collapsed, so typed details survive toggling. */}
          <div id="add-device-details" hidden={!showDetails} className="pt-3">
            <DeviceDetailFields form={form} onChange={setField} disabled={submitting} />
          </div>
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
