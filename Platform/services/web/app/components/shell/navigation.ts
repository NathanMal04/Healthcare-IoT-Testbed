import {
  Boxes,
  Cpu,
  FileCode,
  FolderArchive,
  Gauge,
  LayoutDashboard,
  Microchip,
  NotebookPen,
  ShieldAlert,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ContentWidth } from "@/app/components/ui/Layout";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Research",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/devices", label: "Devices", icon: Cpu },
      { href: "/firmware", label: "Firmware", icon: Microchip },
      { href: "/artifacts", label: "Artifacts", icon: FolderArchive },
      { href: "/vulnerabilities", label: "Vulnerabilities", icon: ShieldAlert },
    ],
  },
  {
    label: "Analysis",
    items: [
      { href: "/scripts", label: "Scripts", icon: FileCode },
      { href: "/environments", label: "Environments", icon: Boxes },
      { href: "/runs", label: "Runs", icon: Workflow },
      // Jupyter analysis sessions (not a device's RE Notebook); the URL stays /notebooks.
      { href: "/notebooks", label: "Analysis Notebooks", icon: NotebookPen },
    ],
  },
];

export const SYSTEM_ITEMS: NavItem[] = [
  { href: "/workspaces", label: "Workspaces", icon: Users },
  { href: "/usage", label: "Usage", icon: Gauge },
];

/**
 * The static export can serve a page as "/devices.html", and a nested page as
 * "/devices/view"; both belong to "/devices".
 */
export function normalizePath(pathname: string | null): string {
  if (!pathname) return "/";
  let path = pathname.replace(/\.html$/, "").replace(/\/index$/, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

export function isActive(pathname: string | null, href: string): boolean {
  const path = normalizePath(pathname);
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

/** The current page's section and title, for the top bar. */
export function currentPage(pathname: string | null): { section: string; title: string } | null {
  const path = normalizePath(pathname);
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (isActive(path, item.href)) {
        return { section: section.label, title: path === "/devices/view" ? "Device" : item.label };
      }
    }
  }
  const system = SYSTEM_ITEMS.find((item) => isActive(path, item.href));
  return system ? { section: "System", title: system.label } : null;
}

/** One step of the breadcrumb trail; the last one is the current page (no link). */
export interface Crumb {
  label: string;
  href?: string;
}

/** Detail pages under a list page, with the label shown until the page names its record. */
const DETAIL_PAGES: Record<string, { parent: string; label: string }> = {
  "/devices/view": { parent: "/devices", label: "Device" },
  "/vulnerabilities/view": { parent: "/vulnerabilities", label: "Vulnerability" },
};

function navItem(href: string): NavItem | undefined {
  return [...NAV_SECTIONS.flatMap((s) => s.items), ...SYSTEM_ITEMS].find((item) => item.href === href);
}

/**
 * The breadcrumb trail for a route: the page, or its list page then the
 * detail. Pages that know their record's name replace the last step (see
 * usePageCrumbs).
 */
export function routeCrumbs(pathname: string | null): Crumb[] {
  const path = normalizePath(pathname);
  const detail = DETAIL_PAGES[path];
  if (detail) {
    const parent = navItem(detail.parent);
    return [{ label: parent?.label ?? detail.parent, href: detail.parent }, { label: detail.label }];
  }
  for (const item of [...NAV_SECTIONS.flatMap((s) => s.items), ...SYSTEM_ITEMS]) {
    if (isActive(path, item.href)) return [{ label: item.label, href: item.href }];
  }
  return [];
}

/**
 * How wide a page's content may grow. Tables and research workspaces use
 * the screen (fluid, up to about 1600px); detail pages with long text and
 * settings-style pages keep the default width.
 */
export function contentWidth(pathname: string | null): ContentWidth {
  const path = normalizePath(pathname);
  if (path === "/vulnerabilities/view" || isActive(path, "/workspaces") || isActive(path, "/usage")) return "default";
  return "fluid";
}
