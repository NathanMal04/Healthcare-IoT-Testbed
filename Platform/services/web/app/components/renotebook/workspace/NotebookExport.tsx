"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import type { Device } from "@/lib/devices";
import { loadNotebookExport, waitForRender, type NotebookExport as ExportData, type RenderWait } from "@/lib/reNotebookExport";
import type { Scope } from "@/lib/workspaces";
import { Alert, Button, Dialog, ErrorState, LoadingState, formatDate } from "@/app/components/ui";
import NotebookDocView from "../NotebookDocView";
import { NotebookImagesProvider } from "../NotebookImage";

/** Set on <body> while an export is open: the print styles then print only the export. */
export const PRINTING_CLASS = "re-notebook-printing";

type Phase =
  | { kind: "entries"; done: number; total: number | null }
  | { kind: "images" }
  | { kind: "ready"; wait: RenderWait }
  | { kind: "error"; message: string };

/**
 * Exports the whole notebook through the browser's print dialog, where
 * "Save as PDF" makes the PDF. Reads the notebook fresh (its saved sections
 * and entries, in order), renders every entry with the notebook's read-only
 * view in a print-only document, waits for its images to load or fail, then
 * opens the print dialog. If something is missing (an entry that couldn't be
 * read, an image that couldn't be shown) it says so and waits for the user
 * to print anyway.
 */
export default function NotebookExport({
  device,
  scope,
  unsavedOpenEntry,
  onClose,
}: {
  device: Device;
  scope: Scope;
  /** The open entry had changes that couldn't be saved: the export has its last saved version. */
  unsavedOpenEntry: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "entries", done: 0, total: null });
  const [data, setData] = useState<ExportData | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [printRoot, setPrintRoot] = useState<HTMLDivElement | null>(null);
  const autoPrinted = useRef(false);
  const exportedAt = useRef(new Date().toISOString());

  // Only the export prints while this is open, under a title that names the
  // PDF the browser suggests.
  useEffect(() => {
    const previousTitle = document.title;
    document.body.classList.add(PRINTING_CLASS);
    document.title = `${device.name} - RE Notebook`;
    return () => {
      document.body.classList.remove(PRINTING_CLASS);
      document.title = previousTitle;
    };
  }, [device.name]);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setPhase({ kind: "entries", done: 0, total: null });
    loadNotebookExport(device.deviceId, {
      signal: controller.signal,
      onProgress: (done, total) => !controller.signal.aborted && setPhase({ kind: "entries", done, total }),
    }).then(
      (loaded) => {
        if (controller.signal.aborted) return;
        setData(loaded);
        setPhase({ kind: "images" });
      },
      (err) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: "error", message: err instanceof Error ? err.message : "Couldn't read the notebook" });
      }
    );
    return () => controller.abort();
  }, [device.deviceId, attempt]);

  // Rendered: wait for the documents and their images.
  useEffect(() => {
    if (!data || !printRoot) return;
    const controller = new AbortController();
    waitForRender(printRoot, {
      documents: data.entryCount - data.failedCount,
      images: data.imageCount,
      signal: controller.signal,
    }).then(
      (wait) => !controller.signal.aborted && setPhase({ kind: "ready", wait }),
      () => undefined
    );
    return () => controller.abort();
  }, [data, printRoot]);

  const print = useCallback(() => {
    document.body.classList.add(PRINTING_CLASS);
    window.print();
  }, []);

  const complete = phase.kind === "ready" && data !== null && data.failedCount === 0 && phase.wait.failed === 0;
  // Everything is there: straight to the print dialog, once.
  useEffect(() => {
    if (!complete || autoPrinted.current) return;
    autoPrinted.current = true;
    print();
  }, [complete, print]);

  return (
    <>
      <Dialog title="Export PDF" subtitle={device.name} size="lg" onClose={onClose}>
        <div className="space-y-4">
          {unsavedOpenEntry && (
            <Alert tone="warning">
              The open entry has changes that couldn&apos;t be saved yet, so the export has its last saved version.
            </Alert>
          )}
          {phase.kind === "entries" && (
            <Progress
              label={phase.total === null ? "Reading the notebook…" : `Reading entries… ${phase.done} of ${phase.total}`}
              value={phase.total ? phase.done / phase.total : 0}
            />
          )}
          {phase.kind === "images" && <LoadingState label="Preparing pages and images…" />}
          {phase.kind === "error" && (
            <ErrorState
              title="Couldn't export the notebook"
              message={phase.message}
              action={
                <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </Button>
              }
            />
          )}
          {phase.kind === "ready" && data && <Summary data={data} wait={phase.wait} />}
          <p className="text-xs text-slate-500">
            The print dialog opens when the notebook is ready. Choose <strong>Save as PDF</strong> as the destination
            to download it.
          </p>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button icon={Printer} onClick={print} disabled={phase.kind !== "ready"}>
              {complete || phase.kind !== "ready" ? "Print or save as PDF" : "Print anyway"}
            </Button>
          </div>
        </div>
      </Dialog>
      {data &&
        createPortal(
          <div ref={setPrintRoot} className="re-notebook-print" aria-hidden="true">
            <NotebookImagesProvider artifactIds={data.imageIds} eager>
              <PrintDocument device={device} scope={scope} data={data} exportedAt={exportedAt.current} />
            </NotebookImagesProvider>
          </div>,
          document.body
        )}
    </>
  );
}

function Progress({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-2" role="status">
      <p className="text-sm text-slate-600">{label}</p>
      <div className="h-1.5 rounded-full bg-surface-sunken overflow-hidden" aria-hidden="true">
        <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

function Summary({ data, wait }: { data: ExportData; wait: RenderWait }) {
  const sections = data.sections.length;
  const failed = data.sections.flatMap((s) => s.entries.filter((e) => !e.doc));
  return (
    <div className="space-y-3" role="status">
      <p className="text-sm text-slate-700">
        {sections} {sections === 1 ? "section" : "sections"}, {data.entryCount}{" "}
        {data.entryCount === 1 ? "entry" : "entries"}
        {data.imageCount > 0 && `, ${data.imageCount} ${data.imageCount === 1 ? "image" : "images"}`}.
      </p>
      {failed.length > 0 && (
        <Alert tone="warning">
          {failed.length === 1 ? "One entry couldn't be read" : `${failed.length} entries couldn't be read`} and{" "}
          {failed.length === 1 ? "is" : "are"} marked in the export: {failed.map((e) => `“${e.entry.title}”`).join(", ")}.
        </Alert>
      )}
      {wait.failed > 0 && (
        <Alert tone="warning">
          {wait.failed === 1 ? "One image" : `${wait.failed} images`}{" "}
          {wait.timedOut ? "didn't load in time" : "couldn't be shown"} and {wait.failed === 1 ? "is" : "are"} shown as a
          placeholder.
        </Alert>
      )}
    </div>
  );
}

/** The printed notebook: a cover with contents, then each section and its entries. */
function PrintDocument({
  device,
  scope,
  data,
  exportedAt,
}: {
  device: Device;
  scope: Scope;
  data: ExportData;
  exportedAt: string;
}) {
  const scopeName = scope.kind === "workspace" ? scope.name : "Personal";
  return (
    <article className="re-notebook-print-document">
      <header className="re-notebook-print-cover">
        <p className="re-notebook-print-eyebrow">Reverse Engineering Notebook</p>
        <h1>{device.name}</h1>
        <p className="re-notebook-print-meta">
          {scopeName} · Exported {formatDate(exportedAt)} · {data.sections.length}{" "}
          {data.sections.length === 1 ? "section" : "sections"}, {data.entryCount}{" "}
          {data.entryCount === 1 ? "entry" : "entries"}
        </p>
        {data.sections.length > 0 && (
          <nav aria-label="Contents" className="re-notebook-print-contents">
            <h2>Contents</h2>
            <ol>
              {data.sections.map(({ section, entries }) => (
                <li key={section.sectionId}>
                  {section.title}
                  {entries.length > 0 && (
                    <ol>
                      {entries.map(({ entry }) => (
                        <li key={entry.entryId}>{entry.title}</li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
      </header>

      {data.sections.map(({ section, entries }) => (
        <section key={section.sectionId} className="re-notebook-print-section">
          <h2 className="re-notebook-print-section-title">{section.title}</h2>
          {entries.length === 0 && <p className="re-notebook-print-empty">No entries in this section.</p>}
          {entries.map(({ entry, doc, error }) => {
            const changedAt = entry.contentUpdatedAt ?? entry.updatedAt;
            const changedBy = entry.contentUpdatedByName ?? entry.updatedByName;
            return (
              <article key={entry.entryId} className="re-notebook-print-entry">
                <h3 className="re-notebook-print-entry-title">{entry.title}</h3>
                <p className="re-notebook-print-meta">
                  Updated {formatDate(changedAt)}
                  {changedBy && ` by ${changedBy}`}
                  {entry.createdByName && ` · Created by ${entry.createdByName}`}
                </p>
                {doc ? (
                  <NotebookDocView doc={doc} label={`Content of ${entry.title}`} />
                ) : (
                  <p className="re-notebook-print-missing">This entry couldn&apos;t be read for the export: {error}</p>
                )}
              </article>
            );
          })}
        </section>
      ))}
    </article>
  );
}
