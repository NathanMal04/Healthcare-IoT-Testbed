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
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        card: "0 1px 2px rgba(16, 34, 70, 0.04), 0 1px 3px rgba(16, 34, 70, 0.06)",
        pop: "0 12px 32px -8px rgba(5, 13, 28, 0.28)",
      },
    },
  },
  plugins: [],
};

export default config;
