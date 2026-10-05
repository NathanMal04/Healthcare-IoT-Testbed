"use client";

// The shared UI kit. Everything is exported from here, so pages import from
// "@/app/components/ui" whichever file a component lives in.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

/** Redirects to /login once auth has loaded without a user. Returns true when the page may render. */
export function useRequireUser(): boolean {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);
  return !loading && !!user;
}

export { formatDate, formatDay, initials } from "@/lib/format";
export {
  buttonClass,
  cardClass,
  dangerButton,
  inputClass,
  labelClass,
  primaryButton,
  secondaryButton,
  selectClass,
  type ButtonSize,
  type ButtonVariant,
} from "./styles";
export { Button, ButtonLink } from "./Button";
export { Badge, ReStatusBadge, SeverityBadge, StatusBadge, type BadgeTone } from "./Badge";
export { Card, CardHeader, MetricCard } from "./Card";
export { PageHeader, ScopeLabel } from "./PageHeader";
export { Alert, EmptyState, ErrorState, LoadingState } from "./States";
export { DataTable, type Column } from "./DataTable";
export { FilterSelect, SearchInput, Toolbar } from "./Toolbar";
export { TabPanel, Tabs, type TabItem } from "./Tabs";
export { ConfirmDialog, Dialog, TextModal } from "./Dialog";
