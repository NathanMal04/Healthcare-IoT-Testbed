"use client";

import { useState } from "react";
import { signUp } from "aws-amplify/auth";
import { useRouter } from "next/navigation";
import Link from "next/link";
import "@/lib/amplify";
import { Alert, Button, inputClass, labelClass } from "@/app/components/ui";
import { AuthHeading, PASSWORD_HINT } from "@/app/components/AuthForm";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signUp({ username: email, password, options: { userAttributes: { email } } });
      router.push(`/confirm?email=${encodeURIComponent(email)}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sign up failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <AuthHeading
        title="Create your account"
        description="We'll email you a code to confirm your address."
      />

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="signup-email">
            Email address
          </label>
          <input
            id="signup-email"
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
          <label className={labelClass} htmlFor="signup-password">
            Password
          </label>
          <input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className={inputClass}
            placeholder="Choose a password"
          />
          <p className="text-xs text-slate-500 mt-1.5">{PASSWORD_HINT}</p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <Button type="submit" disabled={loading} className="w-full h-10">
          {loading ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="text-sm text-slate-500 mt-8">
        Already have an account?{" "}
        <Link href="/login" className="text-brand-600 hover:text-brand-700 font-medium">
          Sign in
        </Link>
      </p>
    </>
  );
}
