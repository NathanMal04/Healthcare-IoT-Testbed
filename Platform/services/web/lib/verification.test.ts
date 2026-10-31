import { describe, expect, it } from "vitest";
import {
  PENDING_MAX_AGE_MS,
  PENDING_VERIFICATION_KEY,
  RESEND_COOLDOWN_MS,
  clearPendingVerification,
  describeVerificationError,
  isWellFormedCode,
  normalizeCode,
  readPendingVerification,
  resendCooldownRemaining,
  routeForSignInStep,
  savePendingVerification,
  type KeyValueStorage,
} from "./verification";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

function cognitoError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe("pending verification storage", () => {
  it("round-trips the email and send time, and never stores anything else", () => {
    const storage = memoryStorage();
    savePendingVerification(" user@example.com ", { codeSentAt: 1000, now: 1000, storage });
    expect(readPendingVerification(storage, 2000)).toEqual({
      email: "user@example.com",
      lastCodeSentAt: 1000,
      updatedAt: 1000,
    });
    expect(Object.keys(JSON.parse(storage.data[PENDING_VERIFICATION_KEY])).sort()).toEqual([
      "email",
      "lastCodeSentAt",
      "updatedAt",
    ]);
  });

  it("keeps the previous send time for the same email (cooldown survives the login redirect)", () => {
    const storage = memoryStorage();
    savePendingVerification("user@example.com", { codeSentAt: 1000, now: 1000, storage });
    savePendingVerification("USER@example.com", { now: 5000, storage });
    expect(readPendingVerification(storage, 5000)?.lastCodeSentAt).toBe(1000);
  });

  it("does not carry a send time over to a different email", () => {
    const storage = memoryStorage();
    savePendingVerification("a@example.com", { codeSentAt: 1000, now: 1000, storage });
    savePendingVerification("b@example.com", { now: 2000, storage });
    expect(readPendingVerification(storage, 2000)).toMatchObject({ email: "b@example.com", lastCodeSentAt: null });
  });

  it("discards stale, malformed and empty records", () => {
    const storage = memoryStorage();
    savePendingVerification("user@example.com", { now: 0, storage });
    expect(readPendingVerification(storage, PENDING_MAX_AGE_MS + 1)).toBeNull();
    expect(storage.data[PENDING_VERIFICATION_KEY]).toBeUndefined();

    expect(readPendingVerification(memoryStorage({ [PENDING_VERIFICATION_KEY]: "{not json" }))).toBeNull();
    const bad = memoryStorage({ [PENDING_VERIFICATION_KEY]: JSON.stringify({ email: 42, updatedAt: 1 }) });
    expect(readPendingVerification(bad, 1)).toBeNull();
    expect(bad.data[PENDING_VERIFICATION_KEY]).toBeUndefined();

    savePendingVerification("   ", { now: 1, storage });
    expect(storage.data[PENDING_VERIFICATION_KEY]).toBeUndefined();
  });

  it("clears the record and tolerates missing storage", () => {
    const storage = memoryStorage();
    savePendingVerification("user@example.com", { now: 1, storage });
    clearPendingVerification(storage);
    expect(readPendingVerification(storage, 1)).toBeNull();
    expect(readPendingVerification(null)).toBeNull();
    expect(() => savePendingVerification("x@example.com", { storage: null })).not.toThrow();
    expect(() => clearPendingVerification(null)).not.toThrow();
  });

  it("swallows storage write failures", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => savePendingVerification("user@example.com", { storage })).not.toThrow();
  });
});

describe("resendCooldownRemaining", () => {
  it("is 60 seconds right after a send and counts down to zero", () => {
    expect(RESEND_COOLDOWN_MS).toBe(60_000);
    expect(resendCooldownRemaining(10_000, 10_000)).toBe(60_000);
    expect(resendCooldownRemaining(10_000, 40_000)).toBe(30_000);
    expect(resendCooldownRemaining(10_000, 70_000)).toBe(0);
    expect(resendCooldownRemaining(10_000, 999_999)).toBe(0);
  });

  it("allows a resend when no send time is known", () => {
    expect(resendCooldownRemaining(null, 1)).toBe(0);
  });

  it("never exceeds the cooldown if the clock went backwards", () => {
    expect(resendCooldownRemaining(1_000_000, 0)).toBe(60_000);
  });
});

describe("codes", () => {
  it("normalizes pasted codes and checks the shape", () => {
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
    expect(isWellFormedCode("123 456")).toBe(true);
    expect(isWellFormedCode("12345")).toBe(false);
    expect(isWellFormedCode("12345a")).toBe(false);
  });
});

describe("describeVerificationError", () => {
  it("explains wrong and expired codes", () => {
    expect(describeVerificationError(cognitoError("CodeMismatchException"), "confirm").message).toMatch(/isn't correct/);
    const expired = describeVerificationError(cognitoError("ExpiredCodeException"), "confirm");
    expect(expired.needsNewCode).toBe(true);
    expect(expired.message).toMatch(/expired/);
    expect(describeVerificationError(cognitoError("TooManyFailedAttemptsException"), "confirm").needsNewCode).toBe(true);
  });

  it("explains Cognito throttling differently for resend and confirm", () => {
    expect(describeVerificationError(cognitoError("LimitExceededException"), "resend").message).toMatch(
      /too many codes.*spam/,
    );
    expect(describeVerificationError(cognitoError("LimitExceededException"), "confirm").message).toMatch(
      /Too many attempts/,
    );
    expect(describeVerificationError(cognitoError("TooManyRequestsException"), "resend").message).toMatch(/wait a minute/);
  });

  it("detects an already-confirmed account from either API", () => {
    const fromConfirm = cognitoError("NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED");
    const fromResend = cognitoError("InvalidParameterException", "User is already confirmed.");
    expect(describeVerificationError(fromConfirm, "confirm").alreadyConfirmed).toBe(true);
    expect(describeVerificationError(fromResend, "resend").alreadyConfirmed).toBe(true);
  });

  it("covers delivery failures, unknown users and network errors", () => {
    expect(describeVerificationError(cognitoError("CodeDeliveryFailureException"), "resend").message).toMatch(/deliver/);
    expect(describeVerificationError(cognitoError("UserNotFoundException"), "resend").message).toMatch(/couldn't find/);
    expect(describeVerificationError(cognitoError("NetworkError"), "confirm").message).toMatch(/Network/);
  });

  it("falls back to the raw message, then to a generic one", () => {
    expect(describeVerificationError(cognitoError("SomethingNew", "Odd failure"), "confirm").message).toBe("Odd failure");
    expect(describeVerificationError(undefined, "resend").message).toMatch(/Couldn't send/);
    expect(describeVerificationError({}, "confirm").message).toMatch(/Verification failed/);
  });
});

describe("routeForSignInStep", () => {
  it("keeps confirmed users going to the dashboard", () => {
    expect(routeForSignInStep("DONE", "u@example.com")).toEqual({ kind: "navigate", href: "/dashboard", signedIn: true });
  });

  it("sends unconfirmed users to /confirm without the email in the URL", () => {
    const route = routeForSignInStep("CONFIRM_SIGN_UP", "u@example.com");
    expect(route).toEqual({ kind: "navigate", href: "/confirm?reason=unconfirmed", signedIn: false });
    expect(JSON.stringify(route)).not.toContain("example.com");
  });

  it("sends a forced password reset to the reset flow", () => {
    expect(routeForSignInStep("RESET_PASSWORD", "u+x@example.com")).toEqual({
      kind: "navigate",
      href: "/forgot-password?email=u%2Bx%40example.com",
      signedIn: false,
    });
  });

  it("refuses to fake a sign-in for unsupported steps", () => {
    expect(routeForSignInStep("CONFIRM_SIGN_IN_WITH_TOTP_CODE", "u@example.com").kind).toBe("error");
  });
});
