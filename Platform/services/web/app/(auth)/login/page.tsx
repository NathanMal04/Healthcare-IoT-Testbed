"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn } from "aws-amplify/auth";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import "@/lib/amplify";
import { useAuth } from "@/context/AuthContext";
import { Alert, Button, LoadingState, inputClass, labelClass } from "@/app/components/ui";
import { AuthHeading } from "@/app/components/AuthForm";
import { VERIFIED_EMAIL_KEY, routeForSignInStep, savePendingVerification } from "@/lib/verification";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const justVerified = searchParams.get("verified") === "1";
  const { refreshUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Coming back from /confirm: prefill the address that was just verified.
  useEffect(() => {
    if (!justVerified) return;
    try {
      const prefill = sessionStorage.getItem(VERIFIED_EMAIL_KEY);
      if (prefill) setEmail(prefill);
      sessionStorage.removeItem(VERIFIED_EMAIL_KEY);
    } catch {
      // storage blocked: the user just types the address
    }
  }, [justVerified]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { nextStep } = await signIn({ username: email, password });
      const route = routeForSignInStep(nextStep.signInStep, email);
      if (route.kind === "error") {
        setError(route.message);
        return;
      }
      if (nextStep.signInStep === "CONFIRM_SIGN_UP") {
        // Unconfirmed account (Cognito UserNotConfirmedException). Keep only the
        // email, in localStorage, so /confirm can resume after a browser restart.
        savePendingVerification(email);
      }
      if (route.signedIn) await refreshUser();
      router.push(route.href);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <AuthHeading title="Welcome back" description="Sign in to your Vzoniq account to continue." />

      {justVerified && (
        <Alert tone="success" className="mb-4">
          Your email is verified. Sign in to continue.
        </Alert>
      )}

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
      <p className="text-sm text-slate-500 mt-2">
        Need to verify your email?{" "}
        <Link
          href="/confirm"
          onClick={() => {
            if (email.trim()) savePendingVerification(email);
          }}
          className="text-brand-600 hover:text-brand-700 font-medium"
        >
          Enter your code
        </Link>
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <LoginForm />
    </Suspense>
  );
}
