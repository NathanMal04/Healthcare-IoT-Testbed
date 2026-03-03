import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import client from "./mongodb";
import { sendEmail } from "./email";
import { ensureSessionCleanupRunsOnce } from "./session-cleanup";

const db = client.db();

ensureSessionCleanupRunsOnce();

const NODE_ENV = process.env.NODE_ENV;

export const auth = betterAuth({
  database: mongodbAdapter(db, { client }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: false,
    resetPasswordTokenExpiresIn: 300,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your Healthcare IoT Testbed password",
        text: `Click the link below to reset your password. This link expires in 5 minutes.\n\n${url}`,
        html: `
          <p>Click the link below to reset your password. This link expires in <strong>5 minutes</strong>.</p>
          <p><a href="${url}">${url}</a></p>
          <p>If you did not request a password reset, you can ignore this email.</p>
        `,
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 3600,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Verify your Healthcare IoT Testbed account",
        text: `Click the link below to verify your email address.\n\n${url}`,
        html: `
          <p>Welcome to the Healthcare IoT Testbed!</p>
          <p>Click the link below to verify your email address:</p>
          <p><a href="${url}">${url}</a></p>
          <p>This link expires in 1 hour.</p>
        `,
      });
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
  },

  trustedOrigins:
    NODE_ENV === "production"
      ? [
          process.env.BETTER_AUTH_URL || "",
          process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
        ].filter(Boolean)
      : ["http://localhost:3000"],
});
