"use client";

import { useState, Suspense } from "react";
import { confirmSignUp } from "aws-amplify/auth";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import "@/lib/amplify";
import { Alert, Button, LoadingState, inputClass, labelClass } from "@/app/components/ui";
import { AuthHeading } from "@/app/components/AuthForm";

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
    <>
      <AuthHeading
        title="Verify your email"
        description={
          <>
            Enter the 6-digit code sent to <span className="text-slate-800 font-medium">{email || "your email"}</span>.
          </>
        }
      />

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="confirm-code">
            Verification code
          </label>
          <input
            id="confirm-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            className={`${inputClass} tracking-[0.4em] text-center text-base font-medium`}
            placeholder="123456"
            maxLength={6}
          />
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <Button type="submit" disabled={loading} className="w-full h-10">
          {loading ? "Verifying…" : "Verify email"}
        </Button>
      </form>

      <p className="text-sm text-slate-500 mt-8">
        Already verified?{" "}
        <Link href="/login" className="text-brand-600 hover:text-brand-700 font-medium">
          Sign in
        </Link>
      </p>
    </>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ConfirmForm />
    </Suspense>
  );
}
