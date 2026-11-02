// Class strings for the few form and surface styles still applied directly
// to native elements. Components (Button, Card, …) are preferred in new code.

/**
 * The keyboard focus ring for custom controls (buttons and inputs have their
 * own). Shown for keyboard focus only.
 */
export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white";

/**
 * The type scale as class strings (tokens in tailwind.config.ts; usage in
 * DESIGN.md). Pages adopt these as they are redesigned.
 */
export const typography = {
  display: "text-display text-slate-900",
  pageTitle: "text-title text-slate-900 break-words",
  sectionTitle: "text-section text-slate-900",
  body: "text-body text-slate-700",
  reading: "text-reading text-slate-800",
  meta: "text-meta text-slate-500",
  label: "text-label uppercase text-slate-500",
  mono: "font-mono text-[0.8125rem] text-slate-800",
} as const;

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "link";
export type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 hover:bg-brand-700 text-white shadow-sm",
  secondary: "bg-white hover:bg-surface-muted text-slate-700 border border-line shadow-sm",
  danger: "bg-red-600 hover:bg-red-700 text-white shadow-sm",
  ghost: "text-slate-600 hover:text-slate-900 hover:bg-surface-sunken",
  link: "text-brand-600 hover:text-brand-700",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-9 px-3.5 text-sm",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md"): string {
  // Link-style buttons sit inline with text, so they get no box.
  if (variant === "link") return `${BUTTON_BASE} ${BUTTON_VARIANTS.link} ${size === "sm" ? "text-xs" : "text-sm"}`;
  return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]}`;
}

export const primaryButton = buttonClass("primary");
export const secondaryButton = buttonClass("secondary");
export const dangerButton = buttonClass("danger");

/** Text inputs, selects and textareas. */
export const inputClass =
  "w-full px-3 py-2 rounded-lg border border-line bg-white text-sm text-slate-800 placeholder:text-slate-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 disabled:opacity-60 disabled:bg-surface-muted";

/** Compact selects used in toolbars and table cells. */
export const selectClass =
  "h-9 pl-3 pr-8 rounded-lg border border-line bg-white text-sm text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 disabled:opacity-60";

export const labelClass = "block text-xs font-medium text-slate-600 mb-1.5";

export const cardClass = "bg-white rounded-xl border border-line shadow-card";
