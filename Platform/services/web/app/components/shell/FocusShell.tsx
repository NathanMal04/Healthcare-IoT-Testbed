"use client";

import WorkspaceDialogs, { WorkspaceNotice } from "@/app/components/WorkspaceDialogs";
import { LoadingState, useRequireUser } from "@/app/components/ui";

/**
 * The signed-in frame for full-screen workspaces (the RE Notebook): the same
 * sign-in requirement, workspace notice and workspace dialogs as AppShell,
 * without its sidebar, top bar or content width limit. The page brings its
 * own compact top bar.
 */
export default function FocusShell({ children }: { children: React.ReactNode }) {
  const ready = useRequireUser();

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingState label="Loading Vzoniq…" />
      </div>
    );
  }

  return (
    <div className="bg-surface-muted">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-white focus:text-sm focus:font-medium focus:text-brand-700 focus:shadow-pop"
      >
        Skip to content
      </a>
      <div className="fixed top-14 inset-x-0 z-30 px-4 empty:hidden pointer-events-none [&>*]:pointer-events-auto [&>*]:max-w-3xl [&>*]:mx-auto">
        <WorkspaceNotice />
      </div>
      {children}
      <WorkspaceDialogs />
    </div>
  );
}
