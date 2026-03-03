"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/app/lib/auth-client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const error = searchParams.get("error");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (token && !error) {
      fetch("/api/verify-via-reset-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }).catch(() => {});
    }
  }, [token, error]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (newPassword !== confirmPassword) {
      setFormError("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setFormError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);

    await authClient.resetPassword(
      { newPassword, token: token! },
      {
        onSuccess: () => {
          setSuccess(true);
          setTimeout(() => router.push("/login"), 2000);
        },
        onError: (ctx) => {
          setLoading(false);
          setFormError(ctx.error.message);
        },
      }
    );
  };

  if (error || !token) {
    return (
      <div className="max-w-md mx-auto mt-20 bg-white rounded-xl border border-slate-200 p-8 text-center">
        <h2 className="text-xl font-semibold text-slate-800 mb-2">Invalid or expired link</h2>
        <p className="text-slate-500 text-sm mb-4">
          This password reset link is invalid or has expired.
        </p>
        <Link href="/forgot-password" className="text-sm text-blue-600 hover:underline">
          Request a new link
        </Link>
      </div>
    );
  }

  if (success) {
    return (
      <div className="max-w-md mx-auto mt-20 bg-white rounded-xl border border-slate-200 p-8 text-center">
        <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-slate-800 mb-2">Password updated</h2>
        <p className="text-slate-500 text-sm">Redirecting to sign in...</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto mt-20">
      <div className="bg-white rounded-xl border border-slate-200 p-8">
        <h1 className="text-2xl font-bold text-slate-800 mb-1">Reset password</h1>
        <p className="text-slate-500 text-sm mb-6">Enter your new password below.</p>

        {formError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">
            {formError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              New password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              placeholder="Min. 8 characters"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Confirm password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              placeholder="Repeat new password"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-medium py-2 rounded-lg text-sm transition-colors"
          >
            {loading ? "Updating..." : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}
