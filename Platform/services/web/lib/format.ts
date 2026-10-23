// Display formatting shared by every page. One implementation of each, so
// dates read the same everywhere.

function parse(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date and time in the viewer's locale, or "—" when missing or unreadable. */
export function formatDate(value?: string | null): string {
  return parse(value)?.toLocaleString() ?? "—";
}

/** Date only (e.g. "Oct 5, 2026"), or "—". */
export function formatDay(value?: string | null): string {
  return parse(value)?.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) ?? "—";
}

/** Initials for an avatar from an email or name ("ipule.pipi@x.com" → "IP"). */
export function initials(text?: string | null): string {
  if (!text) return "?";
  const local = text.split("@")[0];
  const parts = local.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || "?";
}
