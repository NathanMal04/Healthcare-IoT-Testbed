"use client";

import Link from "next/link";
import { ArrowRight, LayoutDashboard } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

// The landing page's calls to action. The static HTML always has the
// signed-out versions; once Cognito reports a session they point at the app.

const PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap bg-brand-600 hover:bg-brand-500 text-white shadow-sm transition-colors";

const SIZES = {
  md: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-[15px]",
};

/** "Get Started" (sign up) for visitors, "Open dashboard" for signed-in users. */
export function GetStartedLink({ size = "md", className = "" }: { size?: keyof typeof SIZES; className?: string }) {
  const { user } = useAuth();
  const icon = size === "lg" ? "h-4 w-4" : "h-3.5 w-3.5";
  return user ? (
    <Link href="/dashboard" className={`${PRIMARY} ${SIZES[size]} ${className}`}>
      <LayoutDashboard className={icon} aria-hidden="true" />
      Open dashboard
    </Link>
  ) : (
    <Link href="/signup" className={`group ${PRIMARY} ${SIZES[size]} ${className}`}>
      Get Started
      <ArrowRight className={`${icon} motion-safe:transition-transform group-hover:translate-x-0.5`} aria-hidden="true" />
    </Link>
  );
}

/** "Sign In"; hidden once signed in, where GetStartedLink already leads to the app. */
export function SignInLink({ className = "" }: { className?: string }) {
  const { user } = useAuth();
  if (user) return null;
  return (
    <Link href="/login" className={className}>
      Sign In
    </Link>
  );
}
