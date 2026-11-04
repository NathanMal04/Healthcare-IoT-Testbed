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
  focusRing,
  typography,
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
export { PageHeader, ReadOnlyMark, ScopeLabel } from "./PageHeader";
export { Alert, EmptyState, ErrorState, LoadingState, Skeleton, SkeletonText, type StateHeadingLevel } from "./States";
export {
  DataTable,
  nextSort,
  type Column,
  type SortDirection,
  type SortState,
  type TableDensity,
} from "./DataTable";
export {
  DescriptionList,
  PageContainer,
  PageSection,
  type ContentWidth,
  type DescriptionItem,
} from "./Layout";
export { Sheet } from "./Sheet";
export { SplitView, DETAIL_LIMITS } from "./SplitView";
export { ResizeHandle } from "./ResizeHandle";
export { useFocusTrap, focusableIn } from "./useFocusTrap";
export { useMediaQuery, LARGE_SCREEN, WIDE_SCREEN } from "./useMediaQuery";
export { useLatestRequest, type LatestRequest } from "./useLatestRequest";
export { FilterSelect, SearchInput, Toolbar } from "./Toolbar";
export { TabPanel, Tabs, type TabItem } from "./Tabs";
export { ConfirmDialog, Dialog, TextModal } from "./Dialog";
export { NavigationGuard } from "./NavigationGuard";
export { RowActionsMenu, type RowAction } from "./RowActionsMenu";
