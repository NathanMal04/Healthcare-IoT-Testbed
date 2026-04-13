"use client";

import { useAuth } from "@/context/AuthContext";
import { useRouter } from "next/navigation";

export default function NavBar() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut();
    router.push("/login");
  };

  return (
    <nav className="bg-slate-900 text-white px-8 py-4 flex items-center justify-between border-b border-slate-700">
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-blue-500" />
        <span className="text-lg font-semibold tracking-tight">Healthcare IoT Testbed</span>
        <span className="text-xs bg-blue-600/80 px-2 py-0.5 rounded-full font-medium tracking-wide">
          DEMO
        </span>
      </div>
      {user && (
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-400">{user.username}</span>
          <button
            onClick={handleSignOut}
            className="text-sm text-slate-400 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
