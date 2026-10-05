import { Search } from "lucide-react";
import { selectClass } from "./styles";

/** The filter row above a table. Wraps on narrow screens. */
export function Toolbar({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-5 py-3 border-b border-line flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div className={`relative w-full sm:w-72 ${className}`}>
      <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full h-9 pl-9 pr-3 rounded-lg border border-line bg-white text-sm text-slate-800 placeholder:text-slate-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
      />
    </div>
  );
}

export function FilterSelect({
  value,
  onChange,
  ariaLabel,
  children,
  className = "",
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${selectClass} ${className}`}
    >
      {children}
    </select>
  );
}
