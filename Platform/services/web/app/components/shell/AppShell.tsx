"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import WorkspaceDialogs, { WorkspaceNotice } from "@/app/components/WorkspaceDialogs";
import { LoadingState, useRequireUser } from "@/app/components/ui";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

/**
 * The signed-in application frame: navy sidebar, top bar with the workspace
 * selector, and the content area. Signed-out visitors are sent to /login.
 * The workspace notice and dialogs stay mounted here for every page.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const ready = useRequireUser();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // The drawer closes whenever the page changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingState label="Loading Vzoniq…" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-white focus:text-sm focus:font-medium focus:text-brand-700 focus:shadow-pop"
      >
        Skip to content
      </a>
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="lg:pl-60 flex flex-col min-h-screen">
        <TopBar onOpenMenu={() => setMenuOpen(true)} />
        <main id="main-content" tabIndex={-1} className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 focus:outline-none">
          <WorkspaceNotice />
          {children}
        </main>
      </div>
      <WorkspaceDialogs />
    </div>
  );
}
