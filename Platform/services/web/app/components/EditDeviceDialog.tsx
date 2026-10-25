"use client";

import { useState } from "react";
import {
  applyDeviceUpdate,
  deviceFormError,
  deviceToForm,
  deviceUpdateBody,
  updateDevice,
  type Device,
  type DeviceForm,
} from "@/lib/devices";
import { useScopeLock } from "@/context/WorkspaceContext";
import { Alert, Button, Dialog } from "@/app/components/ui";
import { DeviceDetailFields, DeviceIdentityFields } from "@/app/components/DeviceFormFields";

/**
 * Edits a device's name, type and optional details, prefilled with its
 * current values. Only the fields that changed are sent; a detail cleared
 * here is removed from the device. The reverse-engineering status is not
 * part of this form and is left as it is.
 */
export default function EditDeviceDialog({
  device,
  onClose,
  onSaved,
}: {
  device: Device;
  onClose: () => void;
  onSaved: (device: Device) => void;
}) {
  const [form, setForm] = useState<DeviceForm>(() => deviceToForm(device));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The edit belongs to the device's scope; don't let the scope change under it.
  useScopeLock(submitting);

  const formError = deviceFormError(form);
  const update = deviceUpdateBody(device, form);
  const changed = Object.keys(update).length > 0;

  function setField(key: keyof DeviceForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function close() {
    if (submitting) return;
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formError || submitting) return;
    if (!changed) {
      onClose();
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await updateDevice(device.deviceId, update);
      onSaved(applyDeviceUpdate(device, updated));
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to save the device");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Edit device" subtitle={device.name} size="lg" onClose={close}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <DeviceIdentityFields form={form} onChange={setField} disabled={submitting} autoFocus />
        <div className="border-t border-line pt-3">
          <p className="text-sm font-medium text-slate-700 mb-3">Additional Details (Optional)</p>
          <DeviceDetailFields form={form} onChange={setField} disabled={submitting} />
        </div>
        {formError && <p className="text-xs text-slate-500">{formError}</p>}
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <div className="flex items-center gap-2 pt-2">
          <Button variant="secondary" onClick={close} disabled={submitting} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || formError !== null || !changed} className="flex-1">
            {submitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
