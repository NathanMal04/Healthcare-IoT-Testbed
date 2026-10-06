"use client";

import { useMemo, useState } from "react";
import { useScopeLock, useWorkspace } from "@/context/WorkspaceContext";
import type { Device } from "@/lib/devices";
import type { Scope } from "@/lib/workspaces";
import { ApiError } from "@/lib/api";
import {
  CHIPSETS_MAX,
  CVSS_VERSIONS,
  DESCRIPTION_MAX_LENGTH,
  EMPTY_CVE_FORM,
  REFERENCES_MAX,
  SEVERITIES,
  SEVERITY_LABELS,
  addChipsets,
  createCveWithDevices,
  cveErrorMessage,
  deleteCve,
  duplicateCveRecordId,
  getCve,
  isNotFound,
  linkDevices,
  normalizeCveId,
  toNewCve,
  validateCveForm,
  type Cve,
  type CveFormErrors,
  type CveFormValues,
  type CveSummary,
  type CvssVersion,
  type LinkFailure,
  type Severity,
} from "@/lib/cves";
import {
  Alert,
  ConfirmDialog,
  Dialog,
  inputClass,
  labelClass,
  primaryButton,
  secondaryButton,
} from "@/app/components/ui";

const UNKNOWN_DEVICE = "Unknown device";
const linkButton = "text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50";

function scopeLabel(scope: Scope): string {
  return scope.kind === "workspace" ? scope.name : "Personal";
}

function deviceName(names: ReadonlyMap<string, string>, deviceId: string): string {
  return names.get(deviceId) ?? UNKNOWN_DEVICE;
}

/** A 409 because another request changed the CVE at the same moment (not the 40-device limit). */
export function isConcurrentChange(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && /changed by another request|in progress/i.test(err.message);
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-red-600 mt-1">{message}</p> : null;
}

// --- Form fields (add and edit) ----------------------------------------------------

export function CveFormFields({
  values,
  onChange,
  errors,
  mode,
  devices,
  disabled,
}: {
  values: CveFormValues;
  onChange: (values: CveFormValues) => void;
  errors: CveFormErrors;
  mode: "create" | "edit";
  /** Devices that can be linked when creating; not shown when editing. */
  devices?: Device[] | null;
  disabled: boolean;
}) {
  const [chipsetInput, setChipsetInput] = useState("");
  const [deviceFilter, setDeviceFilter] = useState("");
  const set = <K extends keyof CveFormValues>(key: K, value: CveFormValues[K]) => onChange({ ...values, [key]: value });
  const canonicalId = normalizeCveId(values.cveId);

  function commitChipsets() {
    if (!chipsetInput.trim()) return;
    set("affectedChipsets", addChipsets(values.affectedChipsets, chipsetInput));
    setChipsetInput("");
  }

  const shownDevices = (devices ?? [])
    .filter((d) => d.name.toLowerCase().includes(deviceFilter.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass} htmlFor="cve-id">
            CVE ID{mode === "create" && " *"}
          </label>
          {mode === "create" ? (
            <>
              <input
                id="cve-id"
                type="text"
                value={values.cveId}
                onChange={(e) => set("cveId", e.target.value)}
                disabled={disabled}
                className={`${inputClass} font-mono`}
                placeholder="CVE-2021-37584"
                autoComplete="off"
              />
              {values.cveId.trim() && canonicalId !== values.cveId && !errors.cveId && (
                <p className="text-xs text-slate-400 mt-1">Saved as {canonicalId}</p>
              )}
            </>
          ) : (
            <p className="font-mono text-sm text-slate-800 py-2">{values.cveId}</p>
          )}
          <FieldError message={errors.cveId} />
        </div>
        <div>
          <label className={labelClass} htmlFor="cve-severity">
            Severity *
          </label>
          <select
            id="cve-severity"
            value={values.severity}
            onChange={(e) => set("severity", e.target.value as Severity | "")}
            disabled={disabled}
            className={inputClass}
          >
            <option value="">Choose…</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]}
              </option>
            ))}
          </select>
          <FieldError message={errors.severity} />
        </div>
        <div>
          <label className={labelClass} htmlFor="cve-score">
            CVSS score
          </label>
          <input
            id="cve-score"
            type="text"
            inputMode="decimal"
            value={values.cvssScore}
            onChange={(e) => set("cvssScore", e.target.value)}
            disabled={disabled}
            className={inputClass}
            placeholder="0–10, e.g. 8.2"
          />
          <FieldError message={errors.cvssScore} />
        </div>
        <div>
          <label className={labelClass} htmlFor="cve-version">
            CVSS version
          </label>
          <select
            id="cve-version"
            value={values.cvssVersion}
            onChange={(e) => set("cvssVersion", e.target.value as CvssVersion | "")}
            disabled={disabled}
            className={inputClass}
          >
            <option value="">—</option>
            {CVSS_VERSIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor="cve-description">
          Description
        </label>
        <textarea
          id="cve-description"
          value={values.description}
          onChange={(e) => set("description", e.target.value)}
          disabled={disabled}
          rows={4}
          className={inputClass}
          placeholder="What the vulnerability is and how it is reached"
        />
        <div className="flex justify-between">
          <FieldError message={errors.description} />
          <span className="text-xs text-slate-400 mt-1 ml-auto">
            {values.description.trim().length}/{DESCRIPTION_MAX_LENGTH}
          </span>
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor="cve-chipsets">
          Affected chipsets
        </label>
        {values.affectedChipsets.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {values.affectedChipsets.map((chipset) => (
              <span key={chipset} className="text-xs bg-surface-sunken text-slate-700 pl-2 pr-1 py-0.5 rounded flex items-center gap-1">
                {chipset}
                <button
                  type="button"
                  aria-label={`Remove ${chipset}`}
                  disabled={disabled}
                  onClick={() => set("affectedChipsets", values.affectedChipsets.filter((c) => c !== chipset))}
                  className="text-slate-400 hover:text-slate-600 px-1"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          id="cve-chipsets"
          type="text"
          value={chipsetInput}
          onChange={(e) => setChipsetInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commitChipsets();
            }
          }}
          onBlur={commitChipsets}
          disabled={disabled || values.affectedChipsets.length >= CHIPSETS_MAX}
          className={inputClass}
          placeholder="MT7610UN — press Enter or comma to add"
        />
        <FieldError message={errors.affectedChipsets} />
      </div>

      <div>
        <label className={labelClass}>References</label>
        <div className="space-y-2">
          {values.references.map((reference, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="url"
                aria-label={`Reference ${i + 1}`}
                value={reference}
                onChange={(e) =>
                  set("references", values.references.map((r, j) => (j === i ? e.target.value : r)))
                }
                disabled={disabled}
                className={inputClass}
                placeholder="https://nvd.nist.gov/vuln/detail/CVE-2021-37584"
              />
              <button
                type="button"
                aria-label={`Remove reference ${i + 1}`}
                disabled={disabled}
                onClick={() => set("references", values.references.filter((_, j) => j !== i))}
                className="text-slate-400 hover:text-slate-600 px-2"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => set("references", [...values.references, ""])}
          disabled={disabled || values.references.length >= REFERENCES_MAX}
          className={`${linkButton} mt-2`}
        >
          + Add reference
        </button>
        <FieldError message={errors.references} />
      </div>

      {mode === "create" && (
        <div>
          <label className={labelClass}>Linked devices</label>
          {devices === null || devices === undefined ? (
            <p className="text-sm text-slate-400">Devices couldn&apos;t be loaded; you can link them after adding the CVE.</p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-slate-400">No devices in this scope yet.</p>
          ) : (
            <>
              {devices.length > 8 && (
                <input
                  type="text"
                  value={deviceFilter}
                  onChange={(e) => setDeviceFilter(e.target.value)}
                  className={`${inputClass} mb-2`}
                  placeholder="Find a device"
                  aria-label="Find a device"
                />
              )}
              <div className="border border-line rounded-lg max-h-48 overflow-y-auto divide-y divide-line">
                {shownDevices.map((device) => (
                  <label key={device.deviceId} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={values.deviceIds.includes(device.deviceId)}
                      disabled={disabled}
                      onChange={(e) =>
                        set(
                          "deviceIds",
                          e.target.checked
                            ? [...values.deviceIds, device.deviceId]
                            : values.deviceIds.filter((id) => id !== device.deviceId)
                        )
                      }
                    />
                    {device.name}
                  </label>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-1">{values.deviceIds.length} selected</p>
            </>
          )}
          <FieldError message={errors.deviceIds} />
        </div>
      )}
    </div>
  );
}

// --- Add CVE -----------------------------------------------------------------------

/**
 * Creates a CVE in the current scope, then links the chosen devices one at a
 * time. The scope can't change until both steps end. If some links fail the
 * CVE is kept and the failures can be retried.
 */
export function AddCveDialog({
  scope,
  devices,
  deviceNames,
  onClose,
  onSaved,
  onOpenExisting,
}: {
  scope: Scope;
  devices: Device[] | null;
  deviceNames: ReadonlyMap<string, string>;
  onClose: () => void;
  /** Called with the CVE as soon as it exists, and again after each retry. */
  onSaved: (cve: Cve) => void;
  onOpenExisting: (cveRecordId: string) => void;
}) {
  const { reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scope.kind === "workspace" ? scope.workspaceId : undefined;
  const [values, setValues] = useState<CveFormValues>(EMPTY_CVE_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [result, setResult] = useState<{ cve: Cve; failed: LinkFailure[] } | null>(null);

  useScopeLock(saving);
  const errors = useMemo(() => validateCveForm(values, { mode: "create" }), [values]);

  function close() {
    if (!saving) onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    setSaving(true);
    setError(null);
    setExistingId(null);
    setProgress(null);
    try {
      const outcome = await createCveWithDevices(toNewCve(values, workspaceId), values.deviceIds, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
      onSaved(outcome.cve);
      if (outcome.failed.length) setResult(outcome);
      else onClose();
    } catch (err) {
      const duplicate = duplicateCveRecordId(err);
      if (duplicate) {
        setExistingId(duplicate);
        setError(`${normalizeCveId(values.cveId)} is already recorded in ${scopeLabel(scope)}.`);
      } else {
        setError(cveErrorMessage(err, "Couldn't add the CVE"));
        if (workspaceId && isNotFound(err)) reportWorkspaceUnavailable();
      }
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }

  async function retry() {
    if (!result) return;
    setSaving(true);
    try {
      const outcome = await linkDevices(
        result.cve.cveRecordId,
        result.failed.map((f) => f.deviceId),
        { cve: result.cve, onProgress: (done, total) => setProgress({ done, total }) }
      );
      const cve = outcome.cve ?? result.cve;
      onSaved(cve);
      if (outcome.failed.length) setResult({ cve, failed: outcome.failed });
      else onClose();
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }

  if (result) {
    const linked = result.cve.deviceIds.length;
    return (
      <Dialog title="CVE added" size="lg" onClose={close}>
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            <span className="font-mono font-medium">{result.cve.cveId}</span> was added to {scopeLabel(scope)}
            {linked > 0 && ` and linked to ${linked} device${linked === 1 ? "" : "s"}`}, but{" "}
            {result.failed.length === 1 ? "1 device" : `${result.failed.length} devices`} couldn&apos;t be linked:
          </p>
          <ul className="text-sm space-y-1">
            {result.failed.map((f) => (
              <li key={f.deviceId} className="text-red-700 bg-red-50 px-3 py-2 rounded-lg">
                <span className="font-medium">{deviceName(deviceNames, f.deviceId)}</span>: {f.message}
              </li>
            ))}
          </ul>
          {progress && (
            <p className="text-xs text-slate-500">
              Linking devices ({Math.min(progress.done + 1, progress.total)} of {progress.total})…
            </p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={close} disabled={saving} className={secondaryButton}>
              Done
            </button>
            <button type="button" onClick={() => void retry()} disabled={saving} className={primaryButton}>
              {saving ? "Retrying…" : "Retry failed links"}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Add CVE" subtitle={`Record a known vulnerability in ${scopeLabel(scope)}`} size="xl" onClose={close}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <CveFormFields
          values={values}
          onChange={setValues}
          errors={showErrors ? errors : {}}
          mode="create"
          devices={devices}
          disabled={saving}
        />
        {error && (
          <Alert
            tone="error"
            action={
              existingId && (
                <button type="button" onClick={() => onOpenExisting(existingId)} className="shrink-0 font-semibold underline">
                  Open existing
                </button>
              )
            }
          >
            {error}
          </Alert>
        )}
        {progress && progress.total > 0 && (
          <p className="text-xs text-slate-500">
            Linking devices ({Math.min(progress.done + 1, progress.total)} of {progress.total})…
          </p>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={close} disabled={saving} className={secondaryButton}>
            Cancel
          </button>
          <button type="submit" disabled={saving} className={primaryButton}>
            {saving ? (progress ? "Linking devices…" : "Adding…") : "Add CVE"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// --- Delete CVE --------------------------------------------------------------------

/**
 * Confirms and deletes one CVE, from its row or its page. If its links
 * changed meanwhile (409), the current device count is shown and the user is
 * asked again.
 */
export function DeleteCveDialog({
  cve,
  scope,
  onCancel,
  onDeleted,
  onGone,
  onRefreshed,
}: {
  cve: CveSummary;
  scope: Scope;
  onCancel: () => void;
  onDeleted: (cveRecordId: string) => void;
  /** The CVE (or access to it) was already gone. */
  onGone: (cveRecordId: string, message: string) => void;
  /** Called with the current CVE when it changed during the delete. */
  onRefreshed?: (cve: Cve) => void;
}) {
  const [current, setCurrent] = useState<CveSummary>(cve);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useScopeLock(busy);

  const id = cve.cveRecordId;
  const alreadyDeleted = `${cve.cveId} was already deleted.`;
  const deviceCount = current.deviceIds.length;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteCve(id);
      onDeleted(id);
    } catch (err) {
      if (isNotFound(err)) {
        onGone(id, alreadyDeleted);
      } else if (isConcurrentChange(err)) {
        try {
          const fresh = await getCve(id);
          setCurrent(fresh);
          onRefreshed?.(fresh);
        } catch (refreshErr) {
          if (isNotFound(refreshErr)) {
            onGone(id, alreadyDeleted);
            return;
          }
        }
        setError("This CVE changed while you were deleting it. Check the details and confirm again.");
      } else {
        setError(cveErrorMessage(err, "Couldn't delete the CVE"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      title={`Delete ${cve.cveId}?`}
      confirmLabel="Delete CVE"
      busyLabel="Deleting…"
      busy={busy}
      error={error}
      onConfirm={() => void remove()}
      onCancel={onCancel}
    >
      <p>
        This removes the CVE record from <span className="font-medium">{scopeLabel(scope)}</span>
        {deviceCount > 0 ? (
          <>
            {" "}and its links to{" "}
            <span className="font-medium">
              {deviceCount} device{deviceCount === 1 ? "" : "s"}
            </span>
            .
          </>
        ) : (
          "."
        )}
      </p>
      <p className="text-slate-500">The devices themselves are not changed or deleted.</p>
    </ConfirmDialog>
  );
}
