import {
  Boxes,
  Cpu,
  FileCode,
  FolderArchive,
  Gauge,
  LayoutDashboard,
  Microchip,
  ShieldAlert,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

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
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
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
