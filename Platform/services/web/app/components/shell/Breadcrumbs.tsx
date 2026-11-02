"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Crumb } from "./navigation";

/**
 * Where the page is: "Devices / Acme Cam 1000". Earlier steps link back up;
 * the last is the current page. On narrow screens only a link to the parent
 * and the current page show.
 */
export default function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (!crumbs.length) return null;
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {parent?.href && (
          <li className="md:hidden shrink-0">
            <Link
              href={parent.href}
              className="inline-flex items-center gap-0.5 rounded-md text-slate-500 hover:text-brand-700 outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Back to </span>
              {parent.label}
            </Link>
          </li>
        )}
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${i}-${crumb.label}`} className={`min-w-0 items-center gap-1.5 ${last ? "flex" : "hidden md:flex shrink-0"}`}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden="true" />}
              {last || !crumb.href ? (
                <span
                  aria-current={last ? "page" : undefined}
                  className={`truncate ${last ? "font-medium text-slate-900" : "text-slate-500"}`}
                  title={crumb.label}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  href={crumb.href}
                  className="truncate rounded-md text-slate-500 hover:text-brand-700 outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
