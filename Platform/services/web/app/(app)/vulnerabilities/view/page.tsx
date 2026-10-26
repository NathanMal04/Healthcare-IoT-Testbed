"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { cveHref } from "@/lib/routes";
import { scopeKey } from "@/lib/workspaces";
import CveDetails, { CVE_TABS, type CveTabId } from "@/app/components/CveDetails";
import { ButtonLink, Card, EmptyState, LoadingState } from "@/app/components/ui";

export default function CveViewPage() {
  // useSearchParams needs a Suspense boundary under static export.
  return (
    <Suspense fallback={<LoadingState />}>
      <CveViewRoute />
    </Suspense>
  );
}

function CveViewRoute() {
  const searchParams = useSearchParams();
  const { scope, scopeReady } = useWorkspace();
  const cveRecordId = searchParams.get("id") ?? "";
  const tabParam = searchParams.get("tab");
  const initialTab: CveTabId = CVE_TABS.includes(tabParam as CveTabId) ? (tabParam as CveTabId) : "description";
  const initialEdit = searchParams.get("edit") === "1";

  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  if (!cveRecordId) {
    return (
      <CveFrame>
        <Card>
          <EmptyState icon={ShieldAlert} title="No CVE selected" action={<BackToListButton />} />
        </Card>
      </CveFrame>
    );
  }
  // Keyed on the scope and CVE: switching workspace remounts the view, so
  // nothing from the previous scope carries over.
  return (
    <CveView
      key={`${scopeKey(scope)}:${cveRecordId}`}
      cveRecordId={cveRecordId}
      initialTab={initialTab}
      initialEdit={initialEdit}
    />
  );
}

function CveView({
  cveRecordId,
  initialTab,
  initialEdit,
}: {
  cveRecordId: string;
  initialTab: CveTabId;
  initialEdit: boolean;
}) {
  const router = useRouter();

  // The edit dialog opens once; drop ?edit=1 so a reload or Back doesn't reopen it.
  useEffect(() => {
    if (initialEdit) router.replace(cveHref(cveRecordId, initialTab === "description" ? undefined : initialTab), { scroll: false });
  }, [initialEdit, initialTab, cveRecordId, router]);

  return (
    <CveDetails
      cveRecordId={cveRecordId}
      initialTab={initialTab}
      initialEdit={initialEdit}
      Frame={CveFrame}
      backAction={<BackToListButton />}
      onTabChange={(next) =>
        router.replace(cveHref(cveRecordId, next === "description" ? undefined : next), { scroll: false })
      }
      onDeleted={() => router.push("/vulnerabilities")}
    />
  );
}

function BackToListButton() {
  return (
    <ButtonLink href="/vulnerabilities" variant="secondary" size="sm">
      Back to Vulnerabilities
    </ButtonLink>
  );
}

/** Breadcrumb and back link shared by every state of the page. */
function CveFrame({ cveId, children }: { cveId?: string; children: React.ReactNode }) {
  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
        <span>Research</span>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
        <Link href="/vulnerabilities" className="hover:text-brand-700">
          Vulnerabilities
        </Link>
        {cveId && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
            <span className="font-mono text-slate-600" aria-current="page">
              {cveId}
            </span>
          </>
        )}
      </nav>
      <Link
        href="/vulnerabilities"
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700 mt-3 mb-4"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to Vulnerabilities
      </Link>
      {children}
    </div>
  );
}
