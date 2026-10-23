import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { WorkspaceProvider } from "@/context/WorkspaceContext";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vzoniq · Healthcare IoT Vulnerability Testbed",
  description: "Healthcare IoT vulnerability research: devices, firmware, artifacts and CVEs.",
};

// Providers only. The signed-in frame lives in app/(app)/layout.tsx and the
// sign-in screens' frame in app/(auth)/layout.tsx; route groups don't change URLs.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} min-h-screen`}>
        <AuthProvider>
          <WorkspaceProvider>{children}</WorkspaceProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
