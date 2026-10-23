"use client";

import { usePathname } from "next/navigation";
import { Bell, Menu } from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { currentPage } from "./navigation";
import { BrandLogo } from "./BrandMark";
import UserMenu from "./UserMenu";
import WorkspaceSelector from "./WorkspaceSelector";

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
      className="relative h-9 w-9 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-surface-sunken"
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

export default function TopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const pathname = usePathname();
  const page = currentPage(pathname);

  return (
    <header className="sticky top-0 z-20 h-16 bg-white/95 backdrop-blur border-b border-line">
      <div className="h-full px-3 sm:px-6 flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open navigation"
          className="lg:hidden h-9 w-9 flex items-center justify-center rounded-lg text-slate-600 hover:bg-surface-sunken"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <BrandLogo className="h-7 w-7 lg:hidden shrink-0 hidden sm:block" />
        {page && (
          <nav aria-label="Breadcrumb" className="hidden md:flex items-center gap-1.5 text-sm min-w-0">
            <span className="text-slate-400">{page.section}</span>
            <span className="text-slate-300" aria-hidden="true">/</span>
            <span className="font-medium text-slate-800 truncate">{page.title}</span>
          </nav>
        )}
        <div className="ml-auto flex items-center gap-1 sm:gap-2 min-w-0">
          <WorkspaceSelector />
          <InvitationsButton />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
