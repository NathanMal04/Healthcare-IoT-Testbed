"use client";

// A plain, typed table: columns, rows, optional row click, and per-column
// hiding on small screens. Sorting and paging stay with the page that owns
// the data; this only renders it consistently.

export type Breakpoint = "sm" | "md" | "lg";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Hide the column below this breakpoint. */
  hideBelow?: Breakpoint;
  className?: string;
  headerClassName?: string;
}

// Full class names so Tailwind keeps them.
const HIDE_BELOW: Record<Breakpoint, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  rowClassName,
  minWidth = "40rem",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Makes rows clickable (and reachable with Enter). Controls inside a row should stop propagation. */
  onRowClick?: (row: T) => void;
  /** Accessible name for a clickable row. */
  rowLabel?: (row: T) => string;
  rowClassName?: (row: T) => string;
  /** The table scrolls sideways below this width instead of crushing columns. */
  minWidth?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="text-left bg-surface-muted border-b border-line">
            {columns.map((column, i) => (
              <th
                key={column.key}
                scope="col"
                className={`py-2.5 text-2xs font-semibold uppercase tracking-wider text-slate-500 ${
                  i === 0 ? "pl-5 pr-3" : i === columns.length - 1 ? "pl-3 pr-5" : "px-3"
                } ${column.hideBelow ? HIDE_BELOW[column.hideBelow] : ""} ${column.headerClassName ?? ""}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(row);
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
              className={`border-b border-line/70 last:border-0 align-top ${
                onRowClick ? "cursor-pointer hover:bg-surface-muted focus-visible:bg-surface-muted" : ""
              } ${rowClassName?.(row) ?? ""}`}
            >
              {columns.map((column, i) => (
                <td
                  key={column.key}
                  className={`py-3 ${i === 0 ? "pl-5 pr-3" : i === columns.length - 1 ? "pl-3 pr-5" : "px-3"} ${
                    column.hideBelow ? HIDE_BELOW[column.hideBelow] : ""
                  } ${column.className ?? ""}`}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
