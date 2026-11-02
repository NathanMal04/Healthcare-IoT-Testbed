# Vzoniq design system

A light, spacious, research-focused interface. The RE Notebook workspace
(`app/components/renotebook/workspace`) is the reference for the experience;
this file is the reference for the parts. Everything is Tailwind tokens
(`tailwind.config.ts`) and the components in this folder. There is no
external UI kit.

Pages adopt these as they are redesigned. Until then, existing classes keep
working: every token here was added alongside what was there, not instead of it.

## Colour

| Token | Use |
| --- | --- |
| `brand-*` | The single accent: primary actions, selection, focus, links. |
| `surface` / `surface-muted` / `surface-sunken` | Cards and panels / the page behind them / wells, placeholders, hovers. |
| `line` / `line-strong` | Hairline borders and dividers / hovered or emphasised borders. |
| `success-*`, `warning-*`, `danger-*`, `info-*` | Status: badges, alerts, inline messages. Use 50/100 for backgrounds and rings, 500 for dots, 700 for text. |
| `severity-{critical,high,medium,low}` and `-bg` | CVE severity, identical everywhere it appears. |
| `navy-*` | Brand identity only: logo, sign-in panel, code blocks. Not application chrome. |

Text is `slate-900` (headings), `slate-800` (body emphasis), `slate-700`
(body), `slate-500` (meta). There is no dark theme.

## Type

| Class (`typography.*` in `styles.ts`) | Size | Use |
| --- | --- | --- |
| `text-display` | 28px | Rare: an empty workspace's first heading. |
| `text-title` | 22px | Page and record titles (one per page, the `h1`). |
| `text-section` | 15px semibold | Section, card and panel headings. |
| `text-body` | 14px | Interface text, tables, forms. |
| `text-reading` | 15px / 28px | Long text: notebook entries, CVE descriptions. |
| `text-meta` | 12px | Timestamps, authors, secondary facts. |
| `text-label` | 11px caps | Group labels and table headers. |
| `font-mono` | 13px | Hashes, offsets, identifiers, commands. |

## Space, shape and widths

- A 4px grid (Tailwind spacing). Gutters are 16 / 24 / 32px (`px-4 sm:px-6 lg:px-8`).
- Radius: 8px for controls (`rounded-lg`), 12px for cards and panels (`rounded-xl`), 16px for sheets on phones.
- Elevation: `shadow-card` for resting surfaces, `shadow-pop` for menus, dialogs and sheets.
- Content widths (`PageContainer`):
  - `fluid` (up to 1600px): tables and research workspaces;
  - `default` (1280px): detail pages;
  - `readable` (720px): forms and long text.

## Interaction

- Focus: every interactive element shows a 2px brand ring for keyboard
  focus (`focusRing` for custom controls; Button has it built in).
- Selection: brand-50 fill with a 3px brand bar on the leading edge (lists,
  table rows via `selectedKey`, vertical tabs).
- Motion only through `motion-safe:`.
- Remembered layout (panel widths, collapsed panels) is stored per user and
  view through `lib/panelLayout.ts`, never content.

## Layout patterns

| Pattern | Parts | Example |
| --- | --- | --- |
| List | `PageHeader`, `Toolbar` / filters, `DataTable` | Devices |
| Master-detail | `SplitView` (detail beside the list on large screens, a `Sheet` below them) | Vulnerabilities, Runs |
| Record | `PageHeader`, vertical `Tabs`, `DescriptionList`, `PageSection` | Device workspace |
| Full-screen workspace | Own top bar, resizable panels, Focus Mode | RE Notebook |
| Form | `PageContainer width="readable"`, `Dialog` or `Sheet` for secondary tasks | Uploads, settings |

## Components

- `DataTable`: opt-in `sortable` columns (the page sorts its rows),
  `stickyHeader`, `density`, `loading` skeleton rows, `empty`, `selectedKey`,
  `caption`.
- `Tabs`: horizontal or vertical. Arrow keys, Home and End move focus.
  Activation is manual by default (Enter or Space), so focus never triggers
  navigation. Use `idPrefix` when a page has two sets of tabs.
- `Badge` (`size="sm"` for dense lists), `StatusBadge`, `SeverityBadge`, `ReStatusBadge`.
- `EmptyState` / `ErrorState`: titles are headings (`headingLevel`, default 3).
- `LoadingState` for a region, `Skeleton` / `SkeletonText` for placeholders
  (decorative; mark the region `aria-busy`).
- `Dialog`: named by its title, traps focus, restores it on close.
- `Sheet`: the same for side panels.
- `PageContainer`, `PageSection`, `DescriptionList`, `SplitView`, `ResizeHandle`.
- Hooks:
  - `useFocusTrap`;
  - `useMediaQuery` (`LARGE_SCREEN`);
  - `useLatestRequest`, which replaces hand-written load-id counters.

## Accessibility checklist

- One `h1` per page; sections and states use the next heading levels.
- Every control has an accessible name; icon-only buttons use `aria-label`.
- Modals (`Dialog`, `Sheet`) are named, trap focus and return it.
- Composite widgets (tabs, menus) follow the WAI-ARIA keyboard patterns.
- Tables have header cells, a caption when the page doesn't otherwise name
  them, and `aria-sort` on sortable columns.
- Component tests run `axeViolations` (`testing/axe.ts`) on new shared components.
