"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession, signOut } from "@/app/lib/auth-client";

export default function NavBar() {
  const { data: session } = useSession();
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut();
    router.push("/login");
    router.refresh();
  };

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
        {session ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-300">{session.user.name}</span>
            <button
              onClick={handleSignOut}
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
