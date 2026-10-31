"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { confirmSignUp, resendSignUpCode } from "aws-amplify/auth";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import "@/lib/amplify";
import { Alert, Button, LoadingState, inputClass, labelClass } from "@/app/components/ui";
import { AuthHeading } from "@/app/components/AuthForm";
import {
  SIGNUP_CODE_VALIDITY_HOURS,
  VERIFICATION_EMAIL_SENDER,
  VERIFIED_EMAIL_KEY,
  clearPendingVerification,
  describeVerificationError,
  isWellFormedCode,
  normalizeCode,
  readPendingVerification,
  resendCooldownRemaining,
  savePendingVerification,
} from "@/lib/verification";

type Notice = { tone: "success" | "info"; text: string } | null;
type ErrorState = { text: string; alreadyConfirmed?: boolean; needsNewCode?: boolean } | null;

function ConfirmForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cameFromUnconfirmedLogin = searchParams.get("reason") === "unconfirmed";

  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [editingEmail, setEditingEmail] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<ErrorState>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [lastCodeSentAt, setLastCodeSentAt] = useState<number | null>(null);
  // Set after Cognito throttles a resend; in memory only (it isn't a real send).
  const [throttledAt, setThrottledAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Restore the pending verification: ?email= (older links) first, then the
  // record saved by signup/login, which survives closing the browser.
  useEffect(() => {
    const fromQuery = searchParams.get("email")?.trim();
    if (fromQuery) {
      savePendingVerification(fromQuery);
      // Drop the address from the URL (history, analytics, shared links).
      router.replace(cameFromUnconfirmedLogin ? "/confirm?reason=unconfirmed" : "/confirm");
    }
    const pending = readPendingVerification();
    const restored = fromQuery || pending?.email || "";
    setEmail(restored);
    setEditingEmail(!restored);
    setLastCodeSentAt(pending?.lastCodeSentAt ?? null);
    setReady(true);
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cooldownMs = Math.max(resendCooldownRemaining(lastCodeSentAt, now), resendCooldownRemaining(throttledAt, now));
  const cooldownSeconds = Math.ceil(cooldownMs / 1000);

  // Tick once a second while the cooldown runs.
  useEffect(() => {
    if (cooldownMs <= 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [cooldownMs]);

  const commitEmail = useCallback(() => {
    const trimmed = email.trim();
    if (!trimmed) return "";
    const previous = readPendingVerification();
    savePendingVerification(trimmed);
    if (previous?.email.toLowerCase() !== trimmed.toLowerCase()) setLastCodeSentAt(null);
    return trimmed;
  }, [email]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const username = commitEmail();
    if (!username) {
      setError({ text: "Enter the email address you signed up with." });
      return;
    }
    if (!isWellFormedCode(code)) {
      setError({ text: "Enter the 6-digit code from the email." });
      return;
    }
    setVerifying(true);
    try {
      await confirmSignUp({ username, confirmationCode: normalizeCode(code) });
      clearPendingVerification();
      try {
        sessionStorage.setItem(VERIFIED_EMAIL_KEY, username);
      } catch {
        // prefill is a convenience only
      }
      router.push("/login?verified=1");
    } catch (err: unknown) {
      const info = describeVerificationError(err, "confirm");
      if (info.alreadyConfirmed) clearPendingVerification();
      setError({ text: info.message, alreadyConfirmed: info.alreadyConfirmed, needsNewCode: info.needsNewCode });
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    if (resending || cooldownMs > 0) return;
    setError(null);
    setNotice(null);
    const username = commitEmail();
    if (!username) {
      setError({ text: "Enter the email address you signed up with." });
      return;
    }
    setResending(true);
    try {
      const details = await resendSignUpCode({ username });
      const sentAt = Date.now();
      savePendingVerification(username, { codeSentAt: sentAt });
      setLastCodeSentAt(sentAt);
      setNow(sentAt);
      setCode("");
      setEditingEmail(false);
      setNotice({
        tone: "success",
        text: `We sent a new code to ${details.destination ?? username}. It replaces any earlier code.`,
      });
    } catch (err: unknown) {
      const info = describeVerificationError(err, "resend");
      if (info.alreadyConfirmed) clearPendingVerification();
      const name = err instanceof Error ? err.name : "";
      if (name === "LimitExceededException" || name === "TooManyRequestsException") {
        const at = Date.now();
        setThrottledAt(at);
        setNow(at);
      }
      setError({ text: info.message, alreadyConfirmed: info.alreadyConfirmed });
    } finally {
      setResending(false);
    }
  };

  if (!ready) return <LoadingState />;

  const resendLabel = resending
    ? "Sending…"
    : cooldownMs > 0
      ? `Resend code in ${cooldownSeconds}s`
      : "Resend verification code";

  return (
    <>
      <AuthHeading
        title="Verify your email"
        description={
          email && !editingEmail ? (
            <>
              Enter the 6-digit code sent to <span className="text-slate-800 font-medium">{email}</span>.
            </>
          ) : (
            "Enter your email address and the 6-digit code we sent you."
          )
        }
      />

      {cameFromUnconfirmedLogin && !notice && !error && (
        <Alert tone="info" className="mb-4">
          Your account isn&apos;t verified yet. Enter the code from your sign-up email, or request a new one below.
        </Alert>
      )}

      <form onSubmit={handleVerify} className="space-y-4" noValidate>
        {editingEmail || !email ? (
          <div>
            <label className={labelClass} htmlFor="confirm-email">
              Email address
            </label>
            <input
              id="confirm-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={inputClass}
              placeholder="you@example.com"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditingEmail(true)}
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Not your email? Change it
          </button>
        )}

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
            maxLength={7}
            aria-describedby="confirm-code-help"
          />
          <p id="confirm-code-help" className="text-xs text-slate-500 mt-1.5">
            Codes expire after {SIGNUP_CODE_VALIDITY_HOURS} hours. Requesting a new code replaces the old one.
          </p>
        </div>

        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {error && (
          <Alert tone="error">
            {error.text}
            {error.alreadyConfirmed && (
              <>
                {" "}
                <Link href="/login" className="font-medium underline">
                  Go to sign in
                </Link>
              </>
            )}
          </Alert>
        )}

        <Button type="submit" disabled={verifying} className="w-full h-10">
          {verifying ? "Verifying…" : "Verify email"}
        </Button>

        <Button
          type="button"
          variant={error?.needsNewCode ? "primary" : "secondary"}
          onClick={handleResend}
          disabled={resending || cooldownMs > 0}
          aria-live="polite"
          className="w-full h-10"
        >
          {resendLabel}
        </Button>
      </form>

      <div className="mt-6 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5 text-xs text-slate-600 space-y-1">
        <p className="font-medium text-slate-700">Can&apos;t find the email?</p>
        <p>
          Check your spam or junk folder for a message from{" "}
          <span className="font-medium break-all">{VERIFICATION_EMAIL_SENDER}</span>. Delivery can take a few minutes. If it
          isn&apos;t there, request a new code.
        </p>
      </div>

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
