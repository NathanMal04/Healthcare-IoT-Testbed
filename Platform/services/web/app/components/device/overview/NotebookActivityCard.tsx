"use client";

import Link from "next/link";
import { FileText, Lock, Maximize2, NotebookPen } from "lucide-react";
import type { Notebook } from "@/lib/reNotebook";
import { notebookSummary } from "@/lib/deviceOverview";
import { formatDate } from "@/lib/format";
import { notebookHref } from "@/lib/routes";
import { Button, ButtonLink, Card, CardHeader, SkeletonText, focusRing } from "@/app/components/ui";
import type { Loadable } from "../useOverviewData";

const SHOWN = 5;

/**
 * The device's RE Notebook at a glance: how many sections and entries it
 * has, and the most recently changed entries, each opening in the
 * full-screen notebook. Editor names and times are shown only when the
 * notebook records them.
 */
export default function NotebookActivityCard({
  deviceId,
  notebook,
  canEdit = true,
}: {
  deviceId: string;
  notebook: Loadable<Notebook>;
  /** False for viewers: no invitation to start writing. */
  canEdit?: boolean;
}) {
  const summary = notebook.data ? notebookSummary(notebook.data, SHOWN) : null;
  return (
    <Card>
      <CardHeader
        title="RE Notebook activity"
        description={
          summary
            ? `${summary.sections} ${summary.sections === 1 ? "section" : "sections"} · ${summary.entries} ${
                summary.entries === 1 ? "entry" : "entries"
              }`
            : undefined
        }
        actions={
          notebook.forbidden ? undefined : (
            <ButtonLink href={notebookHref(deviceId)} variant="secondary" size="sm" icon={Maximize2}>
              Open notebook
            </ButtonLink>
          )
        }
      />
      <div className="p-5">
        {notebook.forbidden ? (
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" aria-hidden="true" />
            <p className="text-sm text-slate-500">You don&apos;t have access to this device&apos;s RE Notebook.</p>
          </div>
        ) : notebook.error && !summary ? (
          <div className="space-y-2">
            <p className="text-meta text-danger-700">{notebook.error}</p>
            <Button variant="secondary" size="sm" onClick={notebook.reload} disabled={notebook.loading}>
              {notebook.loading ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : !summary ? (
          <SkeletonText lines={4} />
        ) : summary.entries === 0 ? (
          <div className="flex items-start gap-3">
            <NotebookPen className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" aria-hidden="true" />
            <p className="text-sm text-slate-500">
              No entries yet.
              {canEdit && (
                <>
                  {" "}
                  <Link href={notebookHref(deviceId)} className={`font-medium text-brand-700 hover:text-brand-800 ${focusRing}`}>
                    Start the notebook
                  </Link>
                </>
              )}
            </p>
          </div>
        ) : (
          <>
            <h3 className="mb-2 text-label uppercase text-slate-400">Recently changed</h3>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {summary.recent.map((entry) => (
                <li key={entry.entryId}>
                  <Link
                    href={notebookHref(deviceId, { section: entry.sectionId, entry: entry.entryId })}
                    className={`flex items-start gap-3 px-3 py-2.5 hover:bg-surface-muted ${focusRing}`}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{entry.title || "Untitled entry"}</span>
                      <span className="block truncate text-meta text-slate-500">
                        {entry.sectionTitle}
                        {entry.editedBy && <> · {entry.editedBy}</>}
                        {entry.editedAt && (
                          <>
                            {" · "}
                            <time dateTime={entry.editedAt}>{formatDate(entry.editedAt)}</time>
                          </>
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}
