// Page-level layout primitives. Pages adopt them as they are redesigned;
// see DESIGN.md for when to use which width.

export type ContentWidth = "fluid" | "default" | "readable";

const WIDTHS: Record<ContentWidth, string> = {
  // Tables and research workspaces: use the screen, up to a comfortable limit.
  fluid: "max-w-content-fluid",
  // Detail pages.
  default: "max-w-content-default",
  // Forms and long text.
  readable: "max-w-content-readable",
};

/** Centers page content at one of the three content widths, with the standard gutters. */
export function PageContainer({
  width = "default",
  className = "",
  children,
}: {
  width?: ContentWidth;
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`mx-auto w-full ${WIDTHS[width]} px-4 sm:px-6 lg:px-8 ${className}`}>{children}</div>;
}

/**
 * A titled region of a page: a heading (h2 by default) with an optional
 * description and actions, then its content. Named by its heading for
 * assistive technology.
 */
export function PageSection({
  id,
  title,
  description,
  actions,
  headingLevel = 2,
  className = "",
  children,
}: {
  /** Used for the heading's id (aria-labelledby). */
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
  children: React.ReactNode;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Heading id={headingId} className="text-section text-slate-900">
            {title}
          </Heading>
          {description && <p className="mt-0.5 text-meta text-slate-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export interface DescriptionItem {
  term: React.ReactNode;
  value: React.ReactNode;
  /** A stable key when `term` isn't a string. */
  key?: string;
}

/**
 * Facts as term and value pairs (a device's manufacturer, a file's hash, …).
 * "stacked" puts each value under its term (narrow panels); "columns" puts
 * them side by side; "grid" lays pairs out in two columns on wider screens.
 */
export function DescriptionList({
  items,
  layout = "columns",
  className = "",
}: {
  items: DescriptionItem[];
  layout?: "stacked" | "columns" | "grid";
  className?: string;
}) {
  const visible = items.filter((item) => item.value !== null && item.value !== undefined && item.value !== "");
  const list =
    layout === "grid" ? "grid gap-x-8 gap-y-3 sm:grid-cols-2" : layout === "columns" ? "space-y-2" : "space-y-3";
  const row =
    layout === "columns"
      ? "grid grid-cols-[minmax(6rem,38%)_minmax(0,1fr)] gap-3"
      : "flex flex-col gap-0.5";
  return (
    <dl className={`${list} ${className}`}>
      {visible.map((item, i) => (
        <div key={item.key ?? (typeof item.term === "string" ? item.term : i)} className={row}>
          <dt className="text-meta text-slate-500">{item.term}</dt>
          <dd className="min-w-0 break-words text-body text-slate-800">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
