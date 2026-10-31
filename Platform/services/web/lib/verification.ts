// Email verification (Cognito sign-up confirmation) helpers shared by the
// login, signup and confirm pages. Pure logic plus a small localStorage record,
// so a user can close the browser and come back to /confirm later.
//
// Only the email address and the time the last code was sent are stored —
// never a password or a verification code.

/** Minimum time between "Resend code" requests, enforced in the UI. */
export const RESEND_COOLDOWN_MS = 60_000;

/**
 * How long a sign-up confirmation code stays valid. Fixed by Cognito (not
 * configurable): codes from SignUp and ResendConfirmationCode last 24 hours.
 * Keep in sync with the cognito-custom-message Lambda's email text.
 */
export const SIGNUP_CODE_VALIDITY_HOURS = 24;

/**
 * Sender shown in the "can't find the email?" hint. The user pool currently
 * sends through Cognito's default email (COGNITO_DEFAULT). Change this if the
 * pool is switched to SES with no-reply@vzoniq.com.
 */
export const VERIFICATION_EMAIL_SENDER = "no-reply@verificationemail.com";

/** A pending record older than this is discarded (it's personal data). */
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const PENDING_VERIFICATION_KEY = "vzoniq.pendingVerification";

/** sessionStorage key: the address just verified, to prefill the login form. */
export const VERIFIED_EMAIL_KEY = "vzoniq.verifiedEmail";

export interface PendingVerification {
  email: string;
  /** Epoch ms of the last code we know Cognito sent, or null if unknown. */
  lastCodeSentAt: number | null;
  /** Epoch ms the record was last written. */
  updatedAt: number;
}

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null when unavailable (SSR, private mode, blocked storage). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function readPendingVerification(
  storage: KeyValueStorage | null = browserStorage(),
  now: number = Date.now(),
): PendingVerification | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_VERIFICATION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PendingVerification>;
    if (typeof data.email !== "string" || !data.email.trim() || !isFiniteNumber(data.updatedAt)) {
      storage.removeItem(PENDING_VERIFICATION_KEY);
      return null;
    }
    if (now - data.updatedAt > PENDING_MAX_AGE_MS) {
      storage.removeItem(PENDING_VERIFICATION_KEY);
      return null;
    }
    return {
      email: data.email.trim(),
      lastCodeSentAt: isFiniteNumber(data.lastCodeSentAt) ? data.lastCodeSentAt : null,
      updatedAt: data.updatedAt,
    };
  } catch {
    return null;
  }
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Remember that `email` is waiting for verification. Pass `codeSentAt` when
 * Cognito has just sent a code (sign-up, resend); otherwise the previous send
 * time for the same address is kept, so the cooldown survives a redirect.
 */
export function savePendingVerification(
  email: string,
  options: { codeSentAt?: number; now?: number; storage?: KeyValueStorage | null } = {},
): void {
  const now = options.now ?? Date.now();
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  if (!storage || !email.trim()) return;
  const previous = readPendingVerification(storage, now);
  const lastCodeSentAt =
    options.codeSentAt ?? (previous && sameEmail(previous.email, email) ? previous.lastCodeSentAt : null);
  const record: PendingVerification = { email: email.trim(), lastCodeSentAt, updatedAt: now };
  try {
    storage.setItem(PENDING_VERIFICATION_KEY, JSON.stringify(record));
  } catch {
    // Storage full or blocked: verification still works, it just won't resume.
  }
}

export function clearPendingVerification(storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(PENDING_VERIFICATION_KEY);
  } catch {
    // ignore
  }
}

/** Milliseconds until another code may be requested (0 = allowed now). */
export function resendCooldownRemaining(
  lastCodeSentAt: number | null,
  now: number = Date.now(),
  cooldownMs: number = RESEND_COOLDOWN_MS,
): number {
  if (lastCodeSentAt === null) return 0;
  const remaining = lastCodeSentAt + cooldownMs - now;
  // Clamp: a clock moved backwards must not lock the button for longer.
  return Math.min(Math.max(0, remaining), cooldownMs);
}

/** Strip spaces/dashes people paste from emails ("123 456"). */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, "");
}

export function isWellFormedCode(code: string): boolean {
  return /^\d{6}$/.test(normalizeCode(code));
}

export interface VerificationErrorInfo {
  message: string;
  /** The account is already confirmed: send the user to sign in. */
  alreadyConfirmed?: boolean;
  /** The code is unusable; the user should request a new one. */
  needsNewCode?: boolean;
}

function errorName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err && typeof (err as { name: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return "";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "";
}

/**
 * Turn a Cognito/Amplify error from confirmSignUp or resendSignUpCode into a
 * message for the verification screen.
 */
export function describeVerificationError(err: unknown, action: "confirm" | "resend"): VerificationErrorInfo {
  const name = errorName(err);
  const raw = errorMessage(err);

  if (/already confirmed|current status is confirmed/i.test(raw)) {
    return { message: "This email address is already verified. You can sign in.", alreadyConfirmed: true };
  }

  switch (name) {
    case "CodeMismatchException":
      return { message: "That code isn't correct. Check the most recent email from Vzoniq and try again." };
    case "ExpiredCodeException":
      return {
        message: "This code has expired or was replaced by a newer one. Request a new code below.",
        needsNewCode: true,
      };
    case "TooManyFailedAttemptsException":
      return {
        message: "Too many incorrect codes. Request a new code, then enter it carefully.",
        needsNewCode: true,
      };
    case "LimitExceededException":
      return {
        message:
          action === "resend"
            ? "You've requested too many codes. Please wait a while before requesting another one, and check your spam folder for earlier emails."
            : "Too many attempts. Please wait a while before trying again.",
      };
    case "TooManyRequestsException":
      return { message: "We're receiving too many requests right now. Please wait a minute and try again." };
    case "CodeDeliveryFailureException":
      return { message: "We couldn't deliver the email. Check that the address is correct, then try again later." };
    case "UserNotFoundException":
      return { message: "We couldn't find an account for that email address. Check it, or create a new account." };
    case "EmptyConfirmSignUpCode":
      return { message: "Enter the 6-digit code from the email." };
    case "EmptySignUpUsername":
    case "EmptyResendSignUpCodeUsername":
      return { message: "Enter the email address you signed up with." };
    case "NetworkError":
      return { message: "Network error. Check your connection and try again." };
  }

  if (raw) return { message: raw };
  return {
    message: action === "resend" ? "Couldn't send a new code. Please try again." : "Verification failed. Please try again.",
  };
}

/**
 * Where the login page goes for a given Amplify v6 sign-in step. Amplify
 * reports Cognito's UserNotConfirmedException as the CONFIRM_SIGN_UP step
 * rather than throwing, so it has to be handled here.
 */
export type SignInRoute =
  | { kind: "navigate"; href: string; signedIn: boolean }
  | { kind: "error"; message: string };

export function routeForSignInStep(step: string, email: string): SignInRoute {
  switch (step) {
    case "DONE":
      return { kind: "navigate", href: "/dashboard", signedIn: true };
    case "CONFIRM_SIGN_UP":
      // The email travels via localStorage, not the URL (no PII in history/logs).
      return { kind: "navigate", href: "/confirm?reason=unconfirmed", signedIn: false };
    case "RESET_PASSWORD":
      return {
        kind: "navigate",
        href: `/forgot-password?email=${encodeURIComponent(email)}`,
        signedIn: false,
      };
    default:
      return {
        kind: "error",
        message: "This account needs an extra sign-in step that Vzoniq doesn't support yet. Contact an administrator.",
      };
  }
}
