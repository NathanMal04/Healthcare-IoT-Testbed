"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchUserAttributes } from "aws-amplify/auth";
import { ChevronDown, LogOut } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { initials } from "@/lib/format";

/** Avatar initials and a menu with the signed-in email and Sign out. */
export default function UserMenu() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The Cognito username is an opaque id; the email is read from the user's
  // own attributes (no backend call beyond Cognito).
  useEffect(() => {
    if (!user) return;
    let active = true;
    fetchUserAttributes()
      .then((attributes) => {
        if (active) setEmail(attributes.email ?? null);
      })
      .catch(() => {
        if (active) setEmail(null);
      });
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.push("/login");
    } finally {
      setSigningOut(false);
    }
  }

  if (!user) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-1.5 h-9 pl-1 pr-1.5 rounded-lg hover:bg-surface-sunken"
      >
        <span className="h-7 w-7 rounded-full bg-navy-800 text-white text-xs font-semibold flex items-center justify-center">
          {initials(email)}
        </span>
        <ChevronDown className="h-4 w-4 text-slate-400 hidden sm:block" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-64 bg-white border border-line rounded-xl shadow-pop py-1.5 z-40">
          <div className="px-3.5 py-2.5 border-b border-line">
            <p className="text-2xs font-medium uppercase tracking-wider text-slate-400">Signed in as</p>
            <p className="text-sm text-slate-800 truncate mt-0.5">{email ?? "your account"}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
            className="w-full flex items-center gap-2 px-3.5 py-2 text-sm text-slate-700 hover:bg-surface-muted disabled:opacity-50"
          >
            <LogOut className="h-4 w-4 text-slate-400" aria-hidden="true" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
