"use client";

import { useState, Suspense } from "react";
import { confirmSignUp } from "aws-amplify/auth";
import { useRouter, useSearchParams } from "next/navigation";
import "@/lib/amplify";

function ConfirmForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";

  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await confirmSignUp({ username: email, confirmationCode: code.trim() });
      router.push("/login");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Confirmation failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-sm font-semibold text-slate-700 tracking-tight">
              Healthcare IoT Testbed
            </span>
          </div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Verify email</h1>
          <p className="text-slate-400 text-sm mt-1">
            Enter the code sent to <span className="text-slate-600 font-medium">{email}</span>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
              Verification Code
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent tracking-widest text-center"
              placeholder="123456"
              maxLength={6}
            />
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            {loading ? "Verifying..." : "Verify email"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense>
      <ConfirmForm />
    </Suspense>
  );
}
