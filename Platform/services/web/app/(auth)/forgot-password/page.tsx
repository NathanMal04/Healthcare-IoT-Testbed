"use client";

import { Suspense, useState } from "react";
import { confirmResetPassword, resetPassword } from "aws-amplify/auth";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import "@/lib/amplify";
import { Alert, Button, ButtonLink, LoadingState, inputClass, labelClass } from "@/app/components/ui";
import { AuthHeading, PASSWORD_HINT } from "@/app/components/AuthForm";

type Step = "request" | "confirm" | "done";

/**
 * Password reset through Cognito: request a code for the account's verified
 * email, then set a new password with it. Uses only the existing user pool.
 */
function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [destination, setDestination] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await resetPassword({ username: email.trim() });
      if (result.nextStep.resetPasswordStep === "DONE") {
        setStep("done");
      } else {
        setDestination(result.nextStep.codeDeliveryDetails?.destination ?? null);
        setStep("confirm");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't start the password reset.");
    } finally {
      setLoading(false);
    }
  }

  async function confirmReset(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("The passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      await confirmResetPassword({ username: email.trim(), confirmationCode: code.trim(), newPassword: password });
      setStep("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't reset the password.");
    } finally {
      setLoading(false);
    }
  }

  if (step === "done") {
    return (
      <>
        <AuthHeading title="Password updated" description="You can now sign in with your new password." />
        <ButtonLink href="/login" variant="primary" className="w-full h-10">
          Back to sign in
        </ButtonLink>
      </>
    );
  }

  if (step === "confirm") {
    return (
      <>
        <AuthHeading
          title="Set a new password"
          description={
            <>
              Enter the code we sent to{" "}
              <span className="text-slate-800 font-medium">{destination ?? "your email"}</span> and choose a new
              password.
            </>
          }
        />
        <form onSubmit={confirmReset} className="space-y-4">
          <div>
            <label className={labelClass} htmlFor="reset-code">
              Verification code
            </label>
            <input
              id="reset-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              maxLength={6}
              className={`${inputClass} tracking-[0.4em] text-center text-base font-medium`}
              placeholder="123456"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="reset-password">
              New password
            </label>
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={inputClass}
            />
            <p className="text-xs text-slate-500 mt-1.5">{PASSWORD_HINT}</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="reset-password-confirm">
              Confirm new password
            </label>
            <input
              id="reset-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" disabled={loading} className="w-full h-10">
            {loading ? "Updating…" : "Update password"}
          </Button>
          <button
            type="button"
            onClick={() => {
              setStep("request");
              setError("");
              setCode("");
            }}
            disabled={loading}
            className="w-full text-sm text-slate-500 hover:text-slate-800"
          >
            Use a different email or send a new code
          </button>
        </form>
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title="Reset your password"
        description="Enter your account's email address and we'll send you a verification code."
      />
      <form onSubmit={requestCode} className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="forgot-email">
            Email address
          </label>
          <input
            id="forgot-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputClass}
            placeholder="you@example.com"
          />
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" disabled={loading || !email.trim()} className="w-full h-10">
          {loading ? "Sending code…" : "Send code"}
        </Button>
      </form>
      <p className="text-sm text-slate-500 mt-8">
        Remembered it?{" "}
        <Link href="/login" className="text-brand-600 hover:text-brand-700 font-medium">
          Back to sign in
        </Link>
      </p>
    </>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
