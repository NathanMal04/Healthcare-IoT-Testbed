"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useWorkspace } from "@/context/WorkspaceContext";
import { readShellPreferences, writeShellPreferences } from "@/lib/shellPreferences";
import WorkspaceDialogs, { WorkspaceNotice } from "@/app/components/WorkspaceDialogs";
import { LoadingState, PageContainer, useRequireUser } from "@/app/components/ui";
import { contentWidth, routeCrumbs } from "./navigation";
import { ShellProvider, useShell } from "./ShellContext";
import Sidebar, { DRAWER_ID } from "./Sidebar";
import TopBar from "./TopBar";

/**
 * The signed-in application frame: the light navigation sidebar (expanded or
 * an icon rail, remembered per user; a drawer on small screens), the compact
 * top bar with breadcrumbs, and the content at the page's width (fluid for
 * tables and research workspaces, default for detail and settings pages).
 * Signed-out visitors are sent to /login. The workspace notice and dialogs
 * stay mounted here for every page.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ShellProvider>
      <Frame>{children}</Frame>
    </ShellProvider>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const ready = useRequireUser();
  const { user } = useAuth();
  const userId = user?.userId;
  const { panel } = useWorkspace();
  const { pageCrumbs } = useShell();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // The user's remembered sidebar mode.
  useEffect(() => {
    if (userId) setCollapsed(readShellPreferences(userId).sidebarCollapsed);
  }, [userId]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      if (userId) writeShellPreferences(userId, { sidebarCollapsed: next });
      return next;
    });
  }, [userId]);

  // The drawer closes when the page changes, and when a workspace dialog
  // (create, members, invitations) opens over it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (panel) setDrawerOpen(false);
  }, [panel]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingState label="Loading Vzoniq…" />
      </div>
    );
  }

  const crumbs = pageCrumbs ?? routeCrumbs(pathname);

  return (
    <div className="min-h-screen bg-surface-muted">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-white focus:text-sm focus:font-medium focus:text-brand-700 focus:shadow-pop"
      >
        Skip to content
      </a>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        drawerOpen={drawerOpen}
        onCloseDrawer={closeDrawer}
      />
      <div
        className={`flex min-h-screen min-w-0 flex-col motion-safe:transition-[padding] motion-safe:duration-200 ${
          collapsed ? "lg:pl-16" : "lg:pl-60"
        }`}
      >
        <TopBar crumbs={crumbs} drawerOpen={drawerOpen} drawerId={DRAWER_ID} onOpenMenu={() => setDrawerOpen(true)} />
        <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 py-6 sm:py-8 focus:outline-none">
          <PageContainer width={contentWidth(pathname)}>
            <WorkspaceNotice />
            {children}
          </PageContainer>
        </main>
      </div>
      <WorkspaceDialogs />
    </div>
  );
}
