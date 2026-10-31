"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ExternalLink, Link2, Plus, ShieldAlert, X } from "lucide-react";
import type { Device } from "@/lib/devices";
import { cveHref } from "@/lib/routes";
import { useScopeLock } from "@/context/WorkspaceContext";
import {
  MAX_DEVICES_PER_CVE,
  cveErrorMessage,
  cveLinkBlocker,
  getCve,
  linkCvesToDevice,
  type Cve,
  type CveLinkFailure,
  type CveSummary,
} from "@/lib/cves";
import CveList from "@/app/components/CveList";
import { CvssScore } from "@/app/components/CveDetails";
import { Alert, Button, ButtonLink, Dialog, EmptyState, LoadingState, SeverityBadge, formatDay } from "@/app/components/ui";

// The device's Link CVEs explorer: the Vulnerabilities list of the scope's
// recorded CVEs, with checkboxes, a details preview that keeps the selection,
// and a footer that links the selected CVEs to the device through the
// existing per-CVE association endpoint.

const BLOCKER_LABELS = { linked: "Already linked", full: `${MAX_DEVICES_PER_CVE} devices already` } as const;
const MAX_SELECTED_SHOWN = 6;

export default function CveLinkExplorer({
  device,
  cves,
  error,
  devices,
  devicesError,
  refreshing,
  onRefresh,
  onLinked,
  onDone,
  onClose,
}: {
  device: Device;
  /** Every CVE recorded in the scope; null while loading. */
  cves: CveSummary[] | null;
  error: string | null;
  devices: Device[] | null;
  devicesError: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** Called with the CVEs as linked, as soon as a run ends (also after partial failures). */
  onLinked: (linked: Cve[]) => void;
  /** Called with how many CVEs were linked when every selected one was; closes the explorer. */
  onDone: (linkedCount: number) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<CveSummary | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<{ linkedCount: number; failed: CveLinkFailure[] } | null>(null);
  const linking = progress !== null;

  // Links belong to this scope; keep it from changing mid-run.
  useScopeLock(linking);

  const byId = useMemo(() => new Map((cves ?? []).map((cve) => [cve.cveRecordId, cve])), [cves]);
  const blocked = useCallback(
    (cve: CveSummary) => {
      const blocker = cveLinkBlocker(cve, device.deviceId);
      return blocker && BLOCKER_LABELS[blocker];
    },
    [device.deviceId]
  );
  // Only what is still in the list and still linkable counts: a refresh may
  // have removed a CVE, or shown it linked meanwhile.
  const chosen = useMemo(
    () => (cves ?? []).filter((cve) => selected.has(cve.cveRecordId) && !blocked(cve)),
    [cves, selected, blocked]
  );

  const close = useCallback(() => {
    if (!linking) onClose();
  }, [linking, onClose]);
  // Escape steps back from a preview before it closes the explorer.
  const escape = useCallback(() => {
    if (linking) return;
    if (preview) setPreview(null);
    else onClose();
  }, [linking, preview, onClose]);

  function deselect(cveRecordId: string) {
    setSelected((current) => {
      const next = new Set(current);
      next.delete(cveRecordId);
      return next;
    });
  }

  async function link() {
    if (linking || !chosen.length) return;
    setFailures(null);
    setProgress({ done: 0, total: chosen.length });
    const outcome = await linkCvesToDevice(
      device.deviceId,
      chosen.map((cve) => cve.cveRecordId),
      { onProgress: (done, total) => setProgress({ done, total }) }
    );
    setProgress(null);
    if (outcome.linked.length) onLinked(outcome.linked);
    // Reload either way, so the list shows what the backend now has.
    onRefresh();
    if (!outcome.failed.length) {
      onDone(outcome.linked.length);
      return;
    }
    // Only the failed CVEs stay selected, ready to retry.
    setSelected(new Set(outcome.failed.map((f) => f.cveRecordId)));
    setFailures({ linkedCount: outcome.linked.length, failed: outcome.failed });
  }

  const count = chosen.length;
  const footer = (
    <div className="space-y-3">
      {failures && (
        <Alert tone="error" onDismiss={() => setFailures(null)}>
          <p className="font-medium">
            {failures.linkedCount
              ? `Linked ${failures.linkedCount} of ${failures.linkedCount + failures.failed.length} CVEs. ${failures.failed.length} couldn't be linked:`
              : `${failures.failed.length === 1 ? "The CVE" : `None of the ${failures.failed.length} CVEs`} could not be linked:`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {failures.failed.map((f) => (
              <li key={f.cveRecordId}>
                <span className="font-mono">{byId.get(f.cveRecordId)?.cveId ?? "Unknown CVE"}</span> — {f.message}
              </li>
            ))}
          </ul>
          <p className="mt-1">They are still selected, so you can try again.</p>
        </Alert>
      )}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="min-w-0 flex-1 flex flex-wrap items-center gap-1.5" aria-live="polite">
          <span className="text-sm font-medium text-slate-800 mr-1">
            {count ? `${count} selected` : "No CVEs selected"}
          </span>
          {chosen.slice(0, MAX_SELECTED_SHOWN).map((cve) => (
            <span
              key={cve.cveRecordId}
              className="inline-flex items-center gap-1 font-mono text-xs pl-2 pr-1 py-0.5 rounded-md bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100"
            >
              {cve.cveId}
              <button
                type="button"
                onClick={() => deselect(cve.cveRecordId)}
                disabled={linking}
                aria-label={`Remove ${cve.cveId} from the selection`}
                className="p-0.5 rounded hover:bg-brand-100 disabled:opacity-50"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
          {count > MAX_SELECTED_SHOWN && (
            <span
              className="text-xs text-slate-500 px-1"
              title={chosen.slice(MAX_SELECTED_SHOWN).map((cve) => cve.cveId).join(", ")}
            >
              +{count - MAX_SELECTED_SHOWN} more
            </span>
          )}
          {count > 0 && !linking && (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          )}
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
          {progress && (
            <div className="flex items-center gap-2 text-xs text-slate-600 sm:mr-2" role="status">
              <span className="h-1.5 w-24 rounded-full bg-surface-sunken overflow-hidden" aria-hidden="true">
                <span
                  className="block h-full bg-brand-500 transition-[width]"
                  style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
                />
              </span>
              Linking {Math.min(progress.done + 1, progress.total)} of {progress.total}…
            </div>
          )}
          <Button variant="secondary" onClick={close} disabled={linking}>
            Cancel
          </Button>
          <Button icon={Link2} onClick={() => void link()} disabled={!count || linking}>
            {linking ? "Linking…" : count ? `Link ${count} CVE${count === 1 ? "" : "s"}` : "Link CVEs"}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog
      size="full"
      title="Link CVEs"
      subtitle={
        <>
          Choose recorded CVEs that affect <span className="font-medium text-slate-800">{device.name}</span>.
        </>
      }
      onClose={close}
      onEscape={escape}
      footer={footer}
    >
      <div className="relative h-full">
        {/* The list stays mounted under a preview, so filters and scroll position survive it. */}
        <div className="absolute inset-0 overflow-y-auto">
          <CveList
            cves={cves}
            error={error}
            devices={devices}
            devicesError={devicesError}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onOpen={setPreview}
            autoFocusSearch
            selection={{ selected, onChange: setSelected, blocked, disabled: linking }}
            actions={(cve) => (
              <Button variant="ghost" size="sm" onClick={() => setPreview(cve)}>
                Details
              </Button>
            )}
            empty={
              <EmptyState
                icon={ShieldAlert}
                title="No CVEs recorded in this scope yet"
                description="Only CVEs recorded on Vulnerabilities can be linked. Record one there first."
                action={
                  <ButtonLink href="/vulnerabilities" variant="secondary" size="sm">
                    Go to Vulnerabilities
                  </ButtonLink>
                }
              />
            }
          />
        </div>
        {preview && (
          <CvePreview
            // The list's copy, so a refresh shows here too.
            cve={byId.get(preview.cveRecordId) ?? preview}
            devices={devices}
            blockedLabel={blocked(byId.get(preview.cveRecordId) ?? preview)}
            selected={selected.has(preview.cveRecordId)}
            disabled={linking}
            onToggle={() =>
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(preview.cveRecordId)) next.delete(preview.cveRecordId);
                else next.add(preview.cveRecordId);
                return next;
              })
            }
            onBack={() => setPreview(null)}
          />
        )}
      </div>
    </Dialog>
  );
}

/**
 * A read-only look at one CVE inside the explorer: everything the list has,
 * plus its references, fetched on open. Editing stays on the CVE's own page.
 */
function CvePreview({
  cve,
  devices,
  blockedLabel,
  selected,
  disabled,
  onToggle,
  onBack,
}: {
  cve: CveSummary;
  devices: Device[] | null;
  blockedLabel: string | null;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onBack: () => void;
}) {
  const [references, setReferences] = useState<string[] | null>(null);
  const [referencesError, setReferencesError] = useState<string | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    backRef.current?.focus();
  }, [cve.cveRecordId]);

  useEffect(() => {
    let active = true;
    setReferences(null);
    setReferencesError(null);
    getCve(cve.cveRecordId).then(
      (full) => active && setReferences(full.references),
      (err) => active && setReferencesError(cveErrorMessage(err, "Couldn't load the references"))
    );
    return () => {
      active = false;
    };
  }, [cve.cveRecordId]);

  const deviceNames = new Map((devices ?? []).map((d) => [d.deviceId, d.name]));
  const linkedNames = cve.deviceIds.map((id) => deviceNames.get(id) ?? "Unknown device").sort((a, b) => a.localeCompare(b));

  return (
    <section
      aria-label={`${cve.cveId} details`}
      className="absolute inset-y-0 right-0 w-full lg:w-[32rem] bg-white lg:border-l border-line lg:shadow-pop overflow-y-auto"
    >
      <div className="sticky top-0 z-10 bg-white border-b border-line px-5 py-3 flex items-center justify-between gap-2">
        <button
          ref={backRef}
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700 rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to results
        </button>
        <a
          href={cveHref(cve.cveRecordId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700"
        >
          Open full page
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>

      <div className="p-5 space-y-5">
        <div>
          <h3 className="font-mono text-lg font-semibold text-slate-900 break-words">{cve.cveId}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <SeverityBadge severity={cve.severity} />
            <span className="text-slate-500">Updated {formatDay(cve.updatedAt)}</span>
          </div>
          <div className="mt-4">
            {blockedLabel ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
                <Check className="h-4 w-4" aria-hidden="true" />
                {blockedLabel}
              </span>
            ) : (
              <Button
                size="sm"
                variant={selected ? "secondary" : "primary"}
                icon={selected ? Check : Plus}
                onClick={onToggle}
                disabled={disabled}
                aria-pressed={selected}
              >
                {selected ? "Selected — click to remove" : "Select to link"}
              </Button>
            )}
          </div>
        </div>

        <PreviewSection title="CVSS score">
          <CvssScore cve={cve} />
        </PreviewSection>

        <PreviewSection title="Description">
          {cve.description ? (
            <p className="text-sm leading-relaxed text-slate-700 whitespace-pre-wrap break-words">{cve.description}</p>
          ) : (
            <p className="text-sm text-slate-400">No description recorded.</p>
          )}
        </PreviewSection>

        <PreviewSection title="Affected chipsets">
          {cve.affectedChipsets.length ? (
            <div className="flex flex-wrap gap-1.5">
              {cve.affectedChipsets.map((chipset) => (
                <span
                  key={chipset}
                  className="font-mono text-xs px-2 py-1 rounded-md bg-surface-sunken text-slate-700 ring-1 ring-inset ring-line"
                >
                  {chipset}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400">No chipsets recorded.</p>
          )}
        </PreviewSection>

        <PreviewSection title={`Linked devices (${cve.deviceIds.length} of ${MAX_DEVICES_PER_CVE})`}>
          {linkedNames.length ? (
            <ul className="text-sm text-slate-700 space-y-1">
              {linkedNames.map((name, i) => (
                <li key={`${name}-${i}`} className="break-words">
                  {name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">No devices linked yet.</p>
          )}
        </PreviewSection>

        <PreviewSection title="References">
          {referencesError ? (
            <p className="text-sm text-slate-500">{referencesError}</p>
          ) : references === null ? (
            <LoadingState label="Loading references…" className="py-2 justify-start" />
          ) : references.length ? (
            <ul className="space-y-1.5">
              {references.map((reference) => (
                <li key={reference}>
                  <a
                    href={reference}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-brand-700 hover:text-brand-800 hover:underline break-all"
                  >
                    {reference}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">No references recorded.</p>
          )}
        </PreviewSection>
      </div>
    </section>
  );
}

function PreviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{title}</h4>
      {children}
    </div>
  );
}
