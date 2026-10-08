"use client";

import { useState } from "react";
import { signIn } from "aws-amplify/auth";
import { useRouter } from "next/navigation";
import Link from "next/link";
import "@/lib/amplify";
import { useAuth } from "@/context/AuthContext";
import { Alert, Button, inputClass, labelClass } from "@/app/components/ui";
import { AuthHeading } from "@/app/components/AuthForm";

export default function LoginPage() {
  const router = useRouter();
  const { refreshUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signIn({ username: email, password });
      await refreshUser();
      router.push("/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <AuthHeading title="Welcome back" description="Sign in to your Vzoniq account to continue." />

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="login-email">
            Email address
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputClass}
            placeholder="you@example.com"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-slate-600" htmlFor="login-password">
              Password
            </label>
            <Link
              href={email ? `/forgot-password?email=${encodeURIComponent(email)}` : "/forgot-password"}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className={inputClass}
            placeholder="Enter your password"
          />
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <Button type="submit" disabled={loading} className="w-full h-10">
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="text-sm text-slate-500 mt-8">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="text-brand-600 hover:text-brand-700 font-medium">
          Create one
        </Link>
      </p>
    </>
  );
}
