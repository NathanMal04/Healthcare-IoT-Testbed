"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Ellipsis, EllipsisVertical, type LucideIcon } from "lucide-react";
import { buttonClass } from "./styles";

export interface RowAction {
  label: string;
  icon: LucideIcon;
  /** A link (e.g. to a detail page) instead of an action. */
  href?: string;
  onSelect?: () => void;
  /** Destructive: shown last, in red, after a divider. */
  danger?: boolean;
  disabled?: boolean;
}

const MENU_WIDTH = 208;
const GAP = 4;

/**
 * The ⋮ menu at the end of a table row (or, with trigger="button", beside a
 * page's primary action). The menu is portalled so a table's overflow can't
 * clip it, and it keeps its clicks and keys from reaching the row, so a row
 * that navigates on click doesn't.
 */
export function RowActionsMenu({
  label,
  actions,
  disabled = false,
  trigger = "row",
}: {
  /** Accessible name of the trigger, e.g. "Actions for CVE-2021-37584". */
  label: string;
  actions: (RowAction | false | null | undefined)[];
  disabled?: boolean;
  trigger?: "row" | "button";
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const items = actions.filter((a): a is RowAction => !!a);
  const ordered = [...items.filter((a) => !a.danger), ...items.filter((a) => a.danger)];
  const firstDanger = ordered.findIndex((a) => a.danger);

  function close(restoreFocus: boolean) {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }

  // Below the trigger, right-aligned; above it when there's no room below.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const height = menuRef.current.offsetHeight;
    const below = rect.bottom + GAP;
    const top = below + height > window.innerHeight && rect.top - GAP - height > 0 ? rect.top - GAP - height : below;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    setPosition({ top, left });
  }, [open]);

  // Focus the first item once the menu is placed (it can't take focus while hidden).
  useEffect(() => {
    if (position) menuItems(menuRef.current)[0]?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    }
    // A fixed menu would drift from its row when the page scrolls.
    function onMove() {
      close(false);
    }
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const list = menuItems(menuRef.current);
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown" ? (index + 1) % list.length
      : e.key === "ArrowUp" ? (index - 1 + list.length) % list.length
      : e.key === "Home" ? 0
      : e.key === "End" ? list.length - 1
      : null;
    if (next !== null) {
      e.preventDefault();
      list[next]?.focus({ preventScroll: true });
    }
  }

  if (!items.length) return null;

  const itemClass = (action: RowAction) =>
    `w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left outline-none disabled:opacity-50 disabled:pointer-events-none ${
      action.danger
        ? "text-red-600 hover:bg-red-50 focus-visible:bg-red-50"
        : "text-slate-700 hover:bg-surface-muted focus-visible:bg-surface-muted"
    }`;

  const TriggerIcon = trigger === "row" ? EllipsisVertical : Ellipsis;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Actions"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close(false);
          else setOpen(true);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={
          trigger === "row"
            ? `h-8 w-8 inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-surface-sunken disabled:opacity-50 disabled:pointer-events-none ${
                open ? "bg-surface-sunken text-slate-900" : ""
              }`
            : `${buttonClass("secondary")} px-2.5`
        }
      >
        <TriggerIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          // Clicks and keys inside the portal still bubble to the row in
          // React's tree, so they stop here.
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onMenuKeyDown}
            style={{ top: position?.top ?? 0, left: position?.left ?? 0, width: MENU_WIDTH, visibility: position ? "visible" : "hidden" }}
            className="fixed z-50 bg-white border border-line rounded-xl shadow-pop py-1.5"
          >
            {ordered.map((action, i) => {
              const Icon = action.icon;
              const content = (
                <>
                  <Icon className={`h-4 w-4 shrink-0 ${action.danger ? "" : "text-slate-400"}`} aria-hidden="true" />
                  {action.label}
                </>
              );
              return (
                <div key={action.label}>
                  {i === firstDanger && i > 0 && <div className="my-1.5 border-t border-line" role="separator" />}
                  {action.href && !action.disabled ? (
                    <Link href={action.href} role="menuitem" tabIndex={-1} onClick={() => close(false)} className={itemClass(action)}>
                      {content}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={action.disabled}
                      onClick={() => {
                        close(false);
                        action.onSelect?.();
                      }}
                      className={itemClass(action)}
                    >
                      {content}
                    </button>
                  )}
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')) : [];
}
