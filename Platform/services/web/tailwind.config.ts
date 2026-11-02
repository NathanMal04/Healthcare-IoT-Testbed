import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Application chrome (sidebar, auth brand panel).
        navy: {
          950: "#050d1c",
          900: "#0a1730",
          800: "#102246",
          700: "#18305c",
          600: "#244276",
          500: "#36588f",
          300: "#93a8cc",
          200: "#bccbe3",
        },
        // The single, restrained accent.
        brand: {
          50: "#eef4ff",
          100: "#dce7fd",
          200: "#bcd0fb",
          500: "#3a74ec",
          600: "#2160d8",
          700: "#1a4db3",
          800: "#183f8f",
        },
        // Content surfaces and hairlines.
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f6f8fb",
          sunken: "#eef2f7",
        },
        line: {
          DEFAULT: "#e3e8ef",
          strong: "#cfd7e3",
        },
        // Semantic tones (badges, alerts, states). The values match the
        // Tailwind palettes used so far, so adopting them changes nothing visually.
        success: { 50: "#ecfdf5", 100: "#d1fae5", 500: "#10b981", 600: "#059669", 700: "#047857", 800: "#065f46" },
        warning: { 50: "#fffbeb", 100: "#fef3c7", 500: "#f59e0b", 600: "#d97706", 700: "#b45309", 800: "#92400e" },
        danger: { 50: "#fef2f2", 100: "#fee2e2", 500: "#ef4444", 600: "#dc2626", 700: "#b91c1c", 800: "#991b1b" },
        info: { 50: "#f0f9ff", 100: "#e0f2fe", 500: "#0ea5e9", 600: "#0284c7", 700: "#0369a1", 800: "#075985" },
        // CVE severity, the same everywhere it appears.
        severity: {
          critical: "#b91c1c",
          "critical-bg": "#fef2f2",
          high: "#c2410c",
          "high-bg": "#fff7ed",
          medium: "#b45309",
          "medium-bg": "#fffbeb",
          low: "#475569",
          "low-bg": "#f1f5f9",
        },
      },
      // The type scale (see app/components/ui/DESIGN.md). Existing sizes stay available.
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        label: ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.05em", fontWeight: "600" }],
        meta: ["0.75rem", { lineHeight: "1rem" }],
        body: ["0.875rem", { lineHeight: "1.375rem" }],
        reading: ["0.9375rem", { lineHeight: "1.75rem" }],
        section: ["0.9375rem", { lineHeight: "1.375rem", fontWeight: "600" }],
        title: ["1.375rem", { lineHeight: "1.75rem", letterSpacing: "-0.01em", fontWeight: "600" }],
        display: ["1.75rem", { lineHeight: "2.25rem", letterSpacing: "-0.015em", fontWeight: "600" }],
      },
      // Content widths: tables and research workspaces use the fluid width,
      // detail pages the default, forms and long text the readable one.
      maxWidth: {
        "content-readable": "45rem",
        "content-default": "80rem",
        "content-fluid": "100rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(16, 34, 70, 0.04), 0 1px 3px rgba(16, 34, 70, 0.06)",
        pop: "0 12px 32px -8px rgba(5, 13, 28, 0.28)",
      },
      // Entrance motion on the landing page; used with motion-safe:.
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
