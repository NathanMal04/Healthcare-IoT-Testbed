"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { legacyNotebookHref } from "@/lib/routes";
import { scopeKey } from "@/lib/workspaces";
import { useWorkspace } from "@/context/WorkspaceContext";
import DeviceView from "@/app/components/device/DeviceView";
import { NoDeviceSelected } from "@/app/components/device/DeviceStates";
import { LoadingState } from "@/app/components/ui";

export default function DeviceViewPage() {
  // useSearchParams needs a Suspense boundary under static export.
  return (
    <Suspense fallback={<LoadingState />}>
      <DeviceViewRoute />
    </Suspense>
  );
}

function DeviceViewRoute() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { scope, scopeReady } = useWorkspace();
  const deviceId = searchParams.get("id") ?? "";
  // The RE Notebook has its own page now; older links to its tab go there.
  const notebookRedirect = legacyNotebookHref(searchParams);
  useEffect(() => {
    if (notebookRedirect) router.replace(notebookRedirect);
  }, [notebookRedirect, router]);

  if (notebookRedirect) return <LoadingState label="Opening the RE Notebook…" />;
  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  if (!deviceId) return <NoDeviceSelected />;
  // Keyed on the scope and device: switching workspace remounts the view, so
  // nothing from the previous scope carries over.
  return <DeviceView key={`${scopeKey(scope)}:${deviceId}`} deviceId={deviceId} />;
}
