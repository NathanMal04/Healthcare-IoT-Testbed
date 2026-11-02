"use client";

import { useEffect } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The elements inside `root` that Tab can reach, in order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest("[hidden], [inert]") && el.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * Keeps keyboard focus inside a modal surface (dialog, sheet) while it is
 * open: Tab and Shift+Tab wrap around inside it. On opening, focus moves into
 * it unless something inside already took it (an autoFocus field); on
 * closing, it goes back to where it was, if that element still exists.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous = document.activeElement as HTMLElement | null;

    if (!root.contains(document.activeElement)) {
      const first = focusableIn(root)[0];
      if (first) first.focus({ preventScroll: true });
      else {
        if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
        root.focus({ preventScroll: true });
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      // A modal nested inside this one handles its own Tab first.
      if (e.key !== "Tab" || e.defaultPrevented || !root) return;
      const items = focusableIn(root);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      if (previous && previous.isConnected && previous !== document.body) previous.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
