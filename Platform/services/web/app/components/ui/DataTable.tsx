"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Skeleton } from "./States";

// A plain, typed table: columns, rows, optional row click, and per-column
// hiding on small screens. Sorting and paging stay with the page that owns
// the data (it sorts the rows); this only renders them consistently. Every
// option below is opt-in: without them a table renders as it always has.

export type Breakpoint = "sm" | "md" | "lg";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Hide the column below this breakpoint. */
  hideBelow?: Breakpoint;
  className?: string;
  headerClassName?: string;
  /** The header becomes a sort button (with `sort` and `onSortChange` on the table). */
  sortable?: boolean;
}

export type SortDirection = "asc" | "desc";
export interface SortState {
  key: string;
  direction: SortDirection;
}

/** The sort after clicking a column's header: a new column sorts ascending, the same one flips. */
export function nextSort(current: SortState | null | undefined, key: string): SortState {
  if (current?.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key, direction: "asc" };
}

export type TableDensity = "comfortable" | "compact";

// Full class names so Tailwind keeps them.
const HIDE_BELOW: Record<Breakpoint, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

const CELL_Y: Record<TableDensity, string> = { comfortable: "py-3", compact: "py-2" };

const edge = (i: number, count: number) => (i === 0 ? "pl-5 pr-3" : i === count - 1 ? "pl-3 pr-5" : "px-3");

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  rowClassName,
  minWidth = "40rem",
  caption,
  sort,
  onSortChange,
  stickyHeader = false,
  density = "comfortable",
  loading = false,
  loadingRows = 5,
  empty,
  selectedKey,
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
  /** Names the table for screen readers (visually hidden). */
  caption?: string;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** Keeps the header visible while the table's scroll container scrolls. */
  stickyHeader?: boolean;
  density?: TableDensity;
  /** Shows placeholder rows (when there are no rows yet) and marks the table busy. */
  loading?: boolean;
  loadingRows?: number;
  /** Shown in place of rows when there are none (and not loading). */
  empty?: React.ReactNode;
  /** The row shown in a detail view beside the table (master-detail). */
  selectedKey?: string | null;
}) {
  const cellY = CELL_Y[density];
  const showSkeleton = loading && rows.length === 0;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }} aria-busy={loading || undefined}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className={stickyHeader ? "sticky top-0 z-10" : undefined}>
          <tr className="text-left bg-surface-muted border-b border-line">
            {columns.map((column, i) => {
              const sortable = !!column.sortable && !!onSortChange;
              const direction = sort?.key === column.key ? sort.direction : null;
              const SortIcon = direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ArrowUpDown;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sortable ? (direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none") : undefined}
                  className={`py-2.5 text-2xs font-semibold uppercase tracking-wider text-slate-500 ${edge(i, columns.length)} ${
                    column.hideBelow ? HIDE_BELOW[column.hideBelow] : ""
                  } ${column.headerClassName ?? ""}`}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange!(nextSort(sort, column.key))}
                      className={`-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase tracking-wider hover:text-slate-800 outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                        direction ? "text-slate-700" : ""
                      }`}
                    >
                      {column.header}
                      <SortIcon className={`h-3 w-3 ${direction ? "" : "opacity-40"}`} aria-hidden="true" />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {showSkeleton &&
            Array.from({ length: loadingRows }, (_, r) => (
              <tr key={`skeleton-${r}`} className="border-b border-line/70 last:border-0" aria-hidden="true">
                {columns.map((column, i) => (
                  <td
                    key={column.key}
                    className={`${cellY} ${edge(i, columns.length)} ${column.hideBelow ? HIDE_BELOW[column.hideBelow] : ""}`}
                  >
                    <Skeleton className={`h-3.5 ${i === 0 ? "w-3/4" : "w-1/2"}`} />
                  </td>
                ))}
              </tr>
            ))}
          {!loading && rows.length === 0 && empty !== undefined && (
            <tr>
              <td colSpan={columns.length} className="p-0">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const key = rowKey(row);
            const selected = selectedKey !== undefined && selectedKey === key;
            return (
              <tr
                key={key}
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
                aria-current={selected ? "true" : undefined}
                className={`border-b border-line/70 last:border-0 align-top ${
                  onRowClick ? "cursor-pointer hover:bg-surface-muted focus-visible:bg-surface-muted" : ""
                } ${selected ? "bg-brand-50/70 shadow-[inset_3px_0_0_0_#2160d8]" : ""} ${rowClassName?.(row) ?? ""}`}
              >
                {columns.map((column, i) => (
                  <td
                    key={column.key}
                    className={`${cellY} ${edge(i, columns.length)} ${column.hideBelow ? HIDE_BELOW[column.hideBelow] : ""} ${
                      column.className ?? ""
                    }`}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
