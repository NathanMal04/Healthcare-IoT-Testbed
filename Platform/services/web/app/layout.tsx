import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Healthcare IoT Testbed",
  description: "IoT device vulnerability analysis platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-slate-50 min-h-screen`}>
        <nav className="bg-slate-900 text-white px-8 py-4 flex items-center gap-3 border-b border-slate-700">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <span className="text-lg font-semibold tracking-tight">Healthcare IoT Testbed</span>
          <span className="text-xs bg-blue-600/80 px-2 py-0.5 rounded-full font-medium tracking-wide">
            DEMO
          </span>
        </nav>
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
