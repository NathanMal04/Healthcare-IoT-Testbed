/** The Vzoniq mark: a shield with a signal trace, drawn inline so no asset is needed. */
export function BrandLogo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="vzoniq-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a74ec" />
          <stop offset="1" stopColor="#1a4db3" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 27 6.6v8.2c0 7.1-4.6 12.3-11 14.7C9.6 27.1 5 21.9 5 14.8V6.6L16 2.5Z" fill="url(#vzoniq-mark)" />
      <path
        d="M9.5 16.2h3.4l1.9-4.4 2.8 8.6 2.1-4.2h2.8"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Logo, product name and descriptor. `tone` is the surface it sits on. */
export function BrandMark({ tone = "dark", compact = false }: { tone?: "dark" | "light"; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <BrandLogo className="h-8 w-8 shrink-0" />
      <div className="min-w-0 leading-tight">
        <p className={`text-[15px] font-semibold tracking-tight ${tone === "dark" ? "text-white" : "text-slate-900"}`}>
          Vzoniq
        </p>
        {!compact && (
          <p className={`text-2xs truncate ${tone === "dark" ? "text-navy-300" : "text-slate-500"}`}>
            Healthcare IoT Vulnerability Testbed
          </p>
        )}
      </div>
    </div>
  );
}
