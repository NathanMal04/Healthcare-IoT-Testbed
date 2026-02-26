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
        <nav className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl font-semibold">Healthcare IoT Testbed</span>
            <span className="text-xs bg-blue-600 px-2 py-0.5 rounded font-medium">
              DEMO
            </span>
          </div>
          <span className="text-sm text-slate-400">
            Florida Institute of Technology
          </span>
        </nav>
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
