"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { getCurrentUser, signOut as amplifySignOut } from "aws-amplify/auth";
import "@/lib/amplify";
import { clearUserDrafts } from "@/lib/reNotebookDrafts";

interface AuthUser {
  username: string;
  userId: string;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signOut: async () => {},
  refreshUser: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCurrentUser()
      .then((u) => setUser({ username: u.username, userId: u.userId }))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const refreshUser = async () => {
    try {
      const u = await getCurrentUser();
      setUser({ username: u.username, userId: u.userId });
    } catch {
      setUser(null);
    }
  };

  const signOut = async () => {
    const userId = user?.userId;
    await amplifySignOut();
    // Unsaved RE Notebook drafts are this user's alone: none stay behind.
    if (userId) clearUserDrafts(userId);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
