"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "./Dialog";

/** The page part of a URL: navigating to the same one (or only its #hash) doesn't leave. */
function pageOf(url: URL): string {
  return `${url.origin}${url.pathname}${url.search}`;
}

/**
 * While `active`, asks before the user leaves the page with work in progress
 * (an upload, a save), using only standard browser behaviour:
 * - in-app links (the sidebar, breadcrumbs, a page's own links) wait for the
 *   answer: Cancel stays, "Leave anyway" follows the link. Links for which
 *   `staysOnPage` is true (e.g. another section of the same page, which keeps
 *   the work running) go straight through;
 * - reloading, closing the tab or typing another address get the browser's
 *   own "Leave site?" prompt (beforeunload).
 *
 * Browser Back and Forward are deliberately not intercepted: neither the
 * browser nor the Next.js app router offers a supported way to cancel them,
 * and rewriting history to fake one discards or duplicates entries. Pages
 * keep their work safe across Back/Forward themselves (the device page keeps
 * a busy section mounted).
 *
 * Links opened in a new tab or window, downloads and other sites are left to
 * the browser.
 */
export function NavigationGuard({
  active,
  title = "Leave while work is in progress?",
  message,
  staysOnPage,
}: {
  active: boolean;
  title?: string;
  message: React.ReactNode;
  staysOnPage?: (url: URL) => boolean;
}) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      // Another site: the browser's own prompt (beforeunload) covers it.
      if (url.origin !== window.location.origin) return;
      if (pageOf(url) === pageOf(new URL(window.location.href))) return;
      if (staysOnPage?.(url)) return;
      // Captured on the document, before the link's own handler: the app
      // router never starts this navigation, and the browser doesn't follow it.
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    }

    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }

    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active, staysOnPage]);

  if (!pendingHref) return null;

  return (
    <ConfirmDialog
      title={title}
      confirmLabel="Leave anyway"
      onConfirm={() => {
        setPendingHref(null);
        router.push(pendingHref);
      }}
      onCancel={() => setPendingHref(null)}
    >
      <p>{message}</p>
      <p className="text-slate-500">Choose Cancel to stay on this page until it finishes.</p>
    </ConfirmDialog>
  );
}
