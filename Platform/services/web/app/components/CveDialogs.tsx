"use client";

import { useEffect, useMemo, useState } from "react";
import { useScopeLock, useWorkspace } from "@/context/WorkspaceContext";
import type { Device } from "@/lib/devices";
import type { Scope } from "@/lib/workspaces";
import { ApiError } from "@/lib/api";
import {
  CHIPSETS_MAX,
  CVSS_VERSIONS,
  DESCRIPTION_MAX_LENGTH,
  EMPTY_CVE_FORM,
  MAX_DEVICES_PER_CVE,
  REFERENCES_MAX,
  SEVERITIES,
  SEVERITY_LABELS,
  addChipsets,
  createCveWithDevices,
  cveChanges,
  cveErrorMessage,
  cveFormValues,
  deleteCve,
  duplicateCveRecordId,
  getCve,
  isNotFound,
  linkCveDevice,
  linkDevices,
  normalizeCveId,
  toNewCve,
  unlinkCveDevice,
  updateCve,
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
  Dialog,
  SeverityBadge,
  dangerButton,
  formatDate,
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

function formatScore(cve: Pick<CveSummary, "cvssScore" | "cvssVersion">): string {
  if (cve.cvssScore === null) return "—";
  return cve.cvssVersion ? `${cve.cvssScore} (CVSS v${cve.cvssVersion})` : String(cve.cvssScore);
}

/** A 409 because another request changed the CVE at the same moment (not the 40-device limit). */
function isConcurrentChange(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && /changed by another request|in progress/i.test(err.message);
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-red-600 mt-1">{message}</p> : null;
}

// --- Form fields (add and edit) ----------------------------------------------------

function CveFormFields({
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

// --- Details, edit, links, delete ----------------------------------------------------

type Mode = "view" | "edit" | "delete";

/**
 * One CVE: shown at once from its list summary, then completed from
 * GET /cves/{id} (references). Edits, device links and deletion happen here;
 * every successful write is passed up so the table stays in step.
 */
export function CveDetailsDialog({
  cveRecordId,
  initial,
  scope,
  devices,
  deviceNames,
  currentUserId,
  onClose,
  onChanged,
  onDeleted,
  onGone,
}: {
  cveRecordId: string;
  initial?: CveSummary;
  scope: Scope;
  devices: Device[] | null;
  deviceNames: ReadonlyMap<string, string>;
  currentUserId?: string;
  onClose: () => void;
  onChanged: (cve: Cve) => void;
  onDeleted: (cveRecordId: string) => void;
  onGone: (cveRecordId: string, message: string) => void;
}) {
  const [cve, setCve] = useState<Cve | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [values, setValues] = useState<CveFormValues>(EMPTY_CVE_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deviceToLink, setDeviceToLink] = useState("");

  useScopeLock(busy !== null);

  // The dialog is keyed on cveRecordId, so a late response always belongs to it.
  useEffect(() => {
    let active = true;
    getCve(cveRecordId)
      .then((full) => {
        if (active) setCve(full);
      })
      .catch((err) => {
        if (!active) return;
        if (isNotFound(err)) onGone(cveRecordId, "This CVE no longer exists, or you no longer have access to it.");
        else setLoadError(cveErrorMessage(err, "Couldn't load the full CVE"));
      });
    return () => {
      active = false;
    };
  }, [cveRecordId, onGone]);

  const shown: CveSummary | null = cve ?? initial ?? null;
  const errors = useMemo(() => validateCveForm(values, { mode: "edit" }), [values]);

  function close() {
    if (!busy) onClose();
  }

  function apply(updated: Cve) {
    setCve(updated);
    onChanged(updated);
  }

  /**
   * Runs one write. A 404 means the CVE (or access to it) is gone, unless the
   * CVE can still be read: then it was the target (e.g. the device) that went.
   */
  async function run(label: string, action: () => Promise<void>, fallback: string, targetGone?: string) {
    setBusy(label);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      if (isNotFound(err)) {
        if (await stillExists()) setActionError(targetGone ?? cveErrorMessage(err, fallback));
        else onGone(cveRecordId, "This CVE no longer exists, or you no longer have access to it.");
      } else if (isConcurrentChange(err)) {
        setActionError("This CVE was changed at the same time by another request. Please try again.");
      } else {
        setActionError(cveErrorMessage(err, fallback));
      }
    } finally {
      setBusy(null);
    }
  }

  async function stillExists(): Promise<boolean> {
    try {
      setCve(await getCve(cveRecordId));
      return true;
    } catch (err) {
      return !isNotFound(err);
    }
  }

  function startEdit() {
    if (!cve) return;
    setValues(cveFormValues(cve));
    setShowErrors(false);
    setActionError(null);
    setMode("edit");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!cve) return;
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    const changes = cveChanges(cve, values);
    if (!Object.keys(changes).length) {
      setMode("view");
      return;
    }
    await run(
      "save",
      async () => {
        apply(await updateCve(cveRecordId, changes));
        setMode("view");
      },
      "Couldn't save the CVE"
    );
  }

  async function link() {
    const deviceId = deviceToLink;
    if (!deviceId) return;
    await run(
      "link",
      async () => {
        apply((await linkCveDevice(cveRecordId, deviceId)).cve);
        setDeviceToLink("");
      },
      "Couldn't link the device",
      "That device is no longer available in this scope."
    );
  }

  async function unlink(deviceId: string) {
    await run(
      `unlink:${deviceId}`,
      async () => apply((await unlinkCveDevice(cveRecordId, deviceId)).cve),
      "Couldn't remove the device"
    );
  }

  async function remove() {
    setBusy("delete");
    setActionError(null);
    try {
      await deleteCve(cveRecordId);
      onDeleted(cveRecordId);
    } catch (err) {
      if (isNotFound(err)) {
        onGone(cveRecordId, `${shown?.cveId ?? "This CVE"} was already deleted.`);
      } else if (isConcurrentChange(err)) {
        // Its links changed meanwhile: show the current count and ask again.
        if (await stillExists()) {
          setActionError("This CVE changed while you were deleting it. Check the details below and confirm again.");
        } else {
          onGone(cveRecordId, `${shown?.cveId ?? "This CVE"} was already deleted.`);
        }
      } else {
        setActionError(cveErrorMessage(err, "Couldn't delete the CVE"));
      }
    } finally {
      setBusy(null);
    }
  }

  if (!shown) {
    return (
      <Dialog title="CVE" size="xl" onClose={close}>
        <p className="text-sm text-slate-400">{loadError ?? "Loading…"}</p>
      </Dialog>
    );
  }

  const linkedIds = shown.deviceIds;
  const linkable = (devices ?? [])
    .filter((d) => !linkedIds.includes(d.deviceId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const atLimit = linkedIds.length >= MAX_DEVICES_PER_CVE;
  const deviceCount = linkedIds.length;

  if (mode === "delete") {
    return (
      <Dialog title={`Delete ${shown.cveId}?`} onClose={close} wide>
        <div className="space-y-4 text-sm text-slate-700">
          <p>
            This removes the CVE record from <span className="font-medium">{scopeLabel(scope)}</span>
            {deviceCount > 0 ? (
              <>
                {" "}and its links to <span className="font-medium">{deviceCount} device{deviceCount === 1 ? "" : "s"}</span>.
              </>
            ) : (
              "."
            )}
          </p>
          <p className="text-slate-500">The devices themselves are not changed or deleted.</p>
          {actionError && <Alert tone="error">{actionError}</Alert>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setMode("view")} disabled={busy !== null} className={secondaryButton}>
              Cancel
            </button>
            <button type="button" onClick={() => void remove()} disabled={busy !== null} className={dangerButton}>
              {busy === "delete" ? "Deleting…" : "Delete CVE"}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (mode === "edit" && cve) {
    return (
      <Dialog title={`Edit ${cve.cveId}`} size="xl" onClose={close}>
        <form onSubmit={save} className="space-y-4" noValidate>
          <CveFormFields
            values={values}
            onChange={setValues}
            errors={showErrors ? errors : {}}
            mode="edit"
            disabled={busy !== null}
          />
          {actionError && <Alert tone="error">{actionError}</Alert>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setMode("view")} disabled={busy !== null} className={secondaryButton}>
              Cancel
            </button>
            <button type="submit" disabled={busy !== null} className={primaryButton}>
              {busy === "save" ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </Dialog>
    );
  }

  const createdBy = currentUserId && shown.createdBy === currentUserId ? "by you" : "by another member";
  return (
    <Dialog
      title={<span className="font-mono">{shown.cveId}</span>}
      subtitle={`Created ${formatDate(shown.createdAt)} ${createdBy} · Updated ${formatDate(shown.updatedAt)}`}
      size="xl"
      onClose={close}
    >
      <div className="space-y-5 text-sm">
        <div className="flex flex-wrap items-center gap-4">
          <SeverityBadge severity={shown.severity} />
          <span className="text-slate-600">CVSS: {formatScore(shown)}</span>
        </div>

        <section>
          <h3 className={labelClass}>Description</h3>
          <p className="text-slate-700 whitespace-pre-wrap break-words">
            {shown.description || <span className="text-slate-400">No description</span>}
          </p>
        </section>

        <section>
          <h3 className={labelClass}>Affected chipsets</h3>
          {shown.affectedChipsets.length ? (
            <div className="flex flex-wrap gap-1.5">
              {shown.affectedChipsets.map((c) => (
                <span key={c} className="text-xs bg-surface-sunken text-slate-700 px-2 py-0.5 rounded">
                  {c}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-slate-400">None recorded</p>
          )}
        </section>

        <section>
          <h3 className={labelClass}>References</h3>
          {!cve ? (
            <p className="text-slate-400">{loadError ?? "Loading…"}</p>
          ) : cve.references.length ? (
            <ul className="space-y-1">
              {cve.references.map((r) => (
                <li key={r}>
                  <a href={r} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:text-brand-700 break-all">
                    {r}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-400">None recorded</p>
          )}
        </section>

        <section>
          <h3 className={labelClass}>
            Linked devices ({deviceCount}/{MAX_DEVICES_PER_CVE})
          </h3>
          {linkedIds.length ? (
            <ul className="divide-y divide-line border border-line rounded-lg mb-3">
              {[...linkedIds]
                .sort((a, b) => deviceName(deviceNames, a).localeCompare(deviceName(deviceNames, b)))
                .map((id) => (
                  <li key={id} className="flex items-center justify-between px-3 py-2">
                    <span className={deviceNames.has(id) ? "text-slate-700" : "text-slate-400 italic"}>
                      {deviceName(deviceNames, id)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void unlink(id)}
                      disabled={busy !== null || !cve}
                      className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
                    >
                      {busy === `unlink:${id}` ? "Removing…" : "Remove"}
                    </button>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-slate-400 mb-3">No devices linked</p>
          )}
          {devices === null ? (
            <p className="text-xs text-slate-400">Devices couldn&apos;t be loaded, so none can be linked right now.</p>
          ) : atLimit ? (
            <p className="text-xs text-slate-500">A CVE can be linked to at most {MAX_DEVICES_PER_CVE} devices.</p>
          ) : linkable.length === 0 ? (
            <p className="text-xs text-slate-400">
              {devices.length ? "Every device in this scope is already linked." : "No devices in this scope yet."}
            </p>
          ) : (
            <div className="flex gap-2">
              <select
                value={deviceToLink}
                onChange={(e) => setDeviceToLink(e.target.value)}
                disabled={busy !== null || !cve}
                aria-label="Device to link"
                className={inputClass}
              >
                <option value="">Link a device…</option>
                {linkable.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void link()}
                disabled={!deviceToLink || busy !== null || !cve}
                className={secondaryButton}
              >
                {busy === "link" ? "Linking…" : "Link"}
              </button>
            </div>
          )}
        </section>

        {actionError && <Alert tone="error">{actionError}</Alert>}

        <div className="flex flex-wrap justify-between gap-3 pt-2 border-t border-line">
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setMode("delete");
            }}
            disabled={busy !== null || !cve}
            className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50 pt-3"
          >
            Delete CVE
          </button>
          <div className="flex gap-3 pt-3">
            <button type="button" onClick={close} disabled={busy !== null} className={secondaryButton}>
              Close
            </button>
            <button type="button" onClick={startEdit} disabled={busy !== null || !cve} className={primaryButton}>
              Edit
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
