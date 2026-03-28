"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { getCurrentUser, signOut as amplifySignOut } from "aws-amplify/auth";
import "@/lib/amplify";

interface AuthUser {
  username: string;
  userId: string;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signOut: async () => {},
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

  const signOut = async () => {
    await amplifySignOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
