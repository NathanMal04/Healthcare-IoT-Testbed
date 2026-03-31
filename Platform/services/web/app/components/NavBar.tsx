"use client";

import Link from "next/link";
import { useAuth } from "@/context/AuthContext";

export default function NavBar() {
  const { user, loading, signOut } = useAuth();

  return (
    <nav className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-xl font-semibold hover:text-slate-300 transition-colors">
          Healthcare IoT Testbed
        </Link>
        <span className="text-xs bg-blue-600 px-2 py-0.5 rounded font-medium">DEMO</span>
      </div>

      <div className="flex items-center gap-4">
        <span className="text-sm text-slate-400">Florida Institute of Technology</span>
        {!loading && user ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-300">{user.username}</span>
            <button
              onClick={signOut}
              className="text-sm bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg transition-colors"
            >
              Sign out
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="text-sm bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors"
          >
            Sign in
          </Link>
        )}
      </div>
    </nav>
  );
}
