import { auth } from "./auth";
import { headers } from "next/headers";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface AuthSession {
  user: AuthUser;
  session: {
    id: string;
    expiresAt: Date;
    createdAt: Date;
  };
}

export async function getAuthUser(): Promise<AuthUser | null> {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      emailVerified: session.user.emailVerified,
    };
  } catch {
    return null;
  }
}

export async function getAuthSession(): Promise<AuthSession | null> {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return null;
    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
      },
      session: {
        id: session.session.id,
        expiresAt: new Date(session.session.expiresAt),
        createdAt: new Date(session.session.createdAt),
      },
    };
  } catch {
    return null;
  }
}

export async function requireAuth(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}
