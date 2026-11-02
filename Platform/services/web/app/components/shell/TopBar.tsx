"use client";

import { Bell, Menu } from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { BrandLogo } from "./BrandMark";
import Breadcrumbs from "./Breadcrumbs";
import type { Crumb } from "./navigation";
import UserMenu from "./UserMenu";

/** Pending workspace invitations, from WorkspaceContext; opens the invitations dialog. */
function InvitationsButton() {
  const { invitations, openPanel } = useWorkspace();
  const pending = invitations?.length ?? 0;
  return (
    <button
      type="button"
      onClick={() => openPanel("invitations")}
      aria-label={pending ? `Invitations (${pending} pending)` : "Invitations"}
      title="Workspace invitations"
      className="relative h-9 w-9 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-surface-sunken outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
      {pending > 0 && (
        <span className="absolute top-1 right-1 min-w-[1rem] h-4 px-1 rounded-full bg-brand-600 text-white text-2xs font-semibold flex items-center justify-center tabular-nums">
          {pending}
        </span>
      )}
    </button>
  );
}

/**
 * The compact (56px) top bar: the navigation menu on small screens, where
 * the page is (breadcrumbs, linking back up), invitations and the account
 * menu (with its sign-out guard).
 */
export default function TopBar({
  crumbs,
  drawerOpen,
  drawerId,
  onOpenMenu,
}: {
  crumbs: Crumb[];
  drawerOpen: boolean;
  drawerId: string;
  onOpenMenu: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 h-14 shrink-0 bg-white/95 backdrop-blur border-b border-line">
      <div className="h-full px-3 sm:px-6 flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls={drawerId}
          className="lg:hidden h-9 w-9 shrink-0 flex items-center justify-center rounded-lg text-slate-600 hover:bg-surface-sunken outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <BrandLogo className="h-7 w-7 lg:hidden shrink-0 hidden sm:block" />
        <Breadcrumbs crumbs={crumbs} />
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <InvitationsButton />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
