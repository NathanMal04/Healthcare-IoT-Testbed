"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Cpu } from "lucide-react";
import { ApiError } from "@/lib/api";
import { getDevice, type Device } from "@/lib/devices";
import { deviceHref, notebookHref } from "@/lib/routes";
import { scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import { useWorkspace } from "@/context/WorkspaceContext";
import { ButtonLink, EmptyState, ErrorState, LoadingState } from "@/app/components/ui";

// The editor (Tiptap) runs in the browser only.
const NotebookWorkspace = dynamic(() => import("@/app/components/renotebook/workspace/NotebookWorkspace"), {
  ssr: false,
  loading: () => <LoadingState className="re-notebook-viewport" label="Loading the RE Notebook…" />,
});

/** /devices/notebook?id={deviceId}[&section={sectionId}][&entry={entryId}]: a device's RE Notebook workspace. */
export default function DeviceNotebookPage() {
  // useSearchParams needs a Suspense boundary under static export.
  return (
    <Suspense fallback={<LoadingState className="re-notebook-viewport" />}>
      <DeviceNotebookRoute />
    </Suspense>
  );
}

function DeviceNotebookRoute() {
  const searchParams = useSearchParams();
  const { scope, scopeReady } = useWorkspace();
  const deviceId = searchParams.get("id") ?? "";

  if (!scopeReady) return <LoadingState className="re-notebook-viewport" label="Loading workspace…" />;
  if (!deviceId) {
    return (
      <Unavailable>
        <EmptyState
          icon={Cpu}
          title="No device selected"
          action={
            <ButtonLink href="/devices" variant="secondary" size="sm">
              Back to Devices
            </ButtonLink>
          }
        />
      </Unavailable>
    );
  }
  // Keyed on the scope and device: switching workspace remounts the page, so
  // nothing from the previous scope carries over.
  return (
    <DeviceNotebook
      key={`${scopeKey(scope)}:${deviceId}`}
      deviceId={deviceId}
      initialSectionId={searchParams.get("section")}
      initialEntryId={searchParams.get("entry")}
    />
  );
}

function DeviceNotebook({
  deviceId,
  initialSectionId,
  initialEntryId,
}: {
  deviceId: string;
  initialSectionId: string | null;
  initialEntryId: string | null;
}) {
  const router = useRouter();
  const { scope } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);
  const [device, setDevice] = useState<Device | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // As on the device page: the device is shown only in its own scope; one of
  // another scope (or one the caller can't use) is treated as not found.
  useEffect(() => {
    let active = true;
    getDevice(deviceId).then(
      (found) => {
        if (!active) return;
        const inScope = found.workspaceId === workspaceId ? found : null;
        setDevice(inScope);
        setNotFound(!inScope);
      },
      (err) => {
        if (!active) return;
        if (err instanceof ApiError && [400, 403, 404].includes(err.status)) setNotFound(true);
        else setLoadError(err instanceof Error ? err.message : "Failed to load the device");
      }
    );
    return () => {
      active = false;
    };
  }, [deviceId, workspaceId]);

  const onLocationChange = useCallback(
    (sectionId: string | null, entryId: string | null) =>
      router.replace(notebookHref(deviceId, { section: sectionId, entry: entryId }), { scroll: false }),
    [router, deviceId]
  );
  const onBack = useCallback(() => router.push(deviceHref(deviceId)), [router, deviceId]);

  if (loadError) {
    return (
      <Unavailable backHref={deviceHref(deviceId)} backLabel="Back to Device">
        <ErrorState title="Couldn't load the device" message={loadError} />
      </Unavailable>
    );
  }
  if (notFound) {
    const scopeName = scope.kind === "workspace" ? scope.name : "Personal";
    return (
      <Unavailable>
        <EmptyState
          icon={Cpu}
          title={`This device isn't available in ${scopeName}.`}
          description="It may belong to a different workspace or to Personal. Switch scope, or go back to this scope's devices."
          action={
            <ButtonLink href="/devices" variant="secondary" size="sm">
              Back to Devices
            </ButtonLink>
          }
        />
      </Unavailable>
    );
  }
  if (!device) return <LoadingState className="re-notebook-viewport" label="Loading device…" />;

  return (
    <NotebookWorkspace
      device={device}
      scope={scope}
      initialSectionId={initialSectionId}
      initialEntryId={initialEntryId}
      onLocationChange={onLocationChange}
      onBack={onBack}
    />
  );
}

/** The frame for a notebook that can't be shown: a back link and the reason. */
function Unavailable({
  children,
  backHref = "/devices",
  backLabel = "Back to Devices",
}: {
  children: React.ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className="re-notebook-viewport flex flex-col">
      <header className="h-14 shrink-0 bg-white border-b border-line px-2 sm:px-4 flex items-center">
        <ButtonLink href={backHref} variant="ghost" size="sm" icon={ArrowLeft}>
          {backLabel}
        </ButtonLink>
      </header>
      <main id="main-content" tabIndex={-1} className="flex-1 p-4 sm:p-6 focus:outline-none">
        <div className="mx-auto max-w-2xl rounded-xl border border-line bg-white shadow-card">{children}</div>
      </main>
    </div>
  );
}
