"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Cpu, FolderArchive, Microchip, Plus, ShieldAlert, Upload } from "lucide-react";
import { getDevices, type Device } from "@/lib/devices";
import { listArtifacts } from "@/lib/artifacts";
import { listCves, type CveSummary } from "@/lib/cves";
import { REVERSE_ENGINEERING_STATUS_LABELS, type ReverseEngineeringStatus } from "@/lib/reverseEngineering";
import { countLabel, recentCves, reProgress, severityCounts } from "@/lib/dashboard";
import { useWorkspace } from "@/context/WorkspaceContext";
import { isWorkspaceUnavailable, scopeKey, scopeWorkspaceId } from "@/lib/workspaces";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  EmptyState,
  LoadingState,
  MetricCard,
  PageHeader,
  SeverityBadge,
  formatDay,
} from "@/app/components/ui";

export default function DashboardPage() {
  const { scope, scopeReady } = useWorkspace();
  // Until the saved workspace is restored, nothing scoped mounts, so no
  // Personal requests go out first.
  if (!scopeReady) return <LoadingState label="Loading workspace…" />;
  // Keyed on the scope: switching remounts the view, so nothing carries over
  // and a late response for the previous scope lands in the unmounted view.
  return <DashboardView key={scopeKey(scope)} />;
}

/** One page of a paged list: its items and whether more pages exist. */
interface PageCount {
  count: number;
  hasMore: boolean;
}

interface Overview {
  devices: Device[] | null;
  cves: CveSummary[] | null;
  firmware: PageCount | null;
  artifacts: PageCount | null;
  errors: string[];
}

const RE_COLORS: Record<ReverseEngineeringStatus, string> = {
  complete: "#10b981",
  in_progress: "#f59e0b",
  not_started: "#cbd5e1",
};
const RE_ORDER: ReverseEngineeringStatus[] = ["complete", "in_progress", "not_started"];

function DashboardView() {
  const { scope, invitations, openPanel, reportWorkspaceUnavailable } = useWorkspace();
  const workspaceId = scopeWorkspaceId(scope);
  const [overview, setOverview] = useState<Overview | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    // Firmware and artifact lists are paged (100 rows per page, type filtered
    // after paging), so only the first page is read: the count is exact when
    // there is no further page and shown as "N+" otherwise.
    const [devices, cves, firmware, artifacts] = await Promise.allSettled([
      getDevices(workspaceId),
      listCves(workspaceId),
      listArtifacts({ type: "firmware", workspaceId, limit: 100 }),
      listArtifacts({ workspaceId, limit: 100 }),
    ]);
    if (!isMountedRef.current || loadId !== loadIdRef.current) return;

    const errors: string[] = [];
    const failed = [devices, cves, firmware, artifacts].filter((r) => r.status === "rejected");
    if (failed.length) errors.push("Some figures couldn't be loaded.");
    if (workspaceId && failed.some((r) => isWorkspaceUnavailable((r as PromiseRejectedResult).reason))) {
      reportWorkspaceUnavailable();
    }
    setOverview({
      devices: devices.status === "fulfilled" ? devices.value : null,
      cves: cves.status === "fulfilled" ? cves.value : null,
      firmware:
        firmware.status === "fulfilled"
          ? { count: firmware.value.artifacts.length, hasMore: !!firmware.value.nextToken }
          : null,
      artifacts:
        artifacts.status === "fulfilled"
          ? { count: artifacts.value.artifacts.length, hasMore: !!artifacts.value.nextToken }
          : null,
      errors,
    });
  }, [workspaceId, reportWorkspaceUnavailable]);

  useEffect(() => {
    void load();
  }, [load]);

  const loading = overview === null;
  const progress = useMemo(() => reProgress(overview?.devices ?? []), [overview?.devices]);
  const severities = useMemo(() => severityCounts(overview?.cves ?? []), [overview?.cves]);
  const recent = useMemo(() => recentCves(overview?.cves ?? [], 5), [overview?.cves]);
  const deviceNames = useMemo(
    () => new Map((overview?.devices ?? []).map((d) => [d.deviceId, d.name])),
    [overview?.devices]
  );
  const pending = invitations?.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Overview of your devices, firmware and vulnerability research"
        scope={scope}
      />

      {pending > 0 && (
        <Alert
          tone="info"
          className="text-sm"
          action={
            <button type="button" onClick={() => openPanel("invitations")} className="shrink-0 font-semibold hover:underline">
              Review
            </button>
          }
        >
          You have {pending} pending workspace invitation{pending === 1 ? "" : "s"}.
        </Alert>
      )}

      {overview?.errors.map((error) => (
        <Alert key={error} tone="warning">
          {error}
        </Alert>
      ))}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          label="Devices"
          icon={Cpu}
          href="/devices"
          loading={loading}
          value={overview?.devices ? overview.devices.length : "—"}
          hint={overview?.devices ? `${progress.counts.complete} fully reverse-engineered` : undefined}
        />
        <MetricCard
          label="Vulnerabilities"
          icon={ShieldAlert}
          href="/vulnerabilities"
          loading={loading}
          value={overview?.cves ? overview.cves.length : "—"}
          hint={overview?.cves ? `${severities.critical} critical · ${severities.high} high` : undefined}
        />
        <MetricCard
          label="Firmware"
          icon={Microchip}
          href="/firmware"
          loading={loading}
          value={overview?.firmware ? countLabel(overview.firmware.count, overview.firmware.hasMore) : "—"}
          hint={overview?.firmware?.hasMore ? "Firmware in the latest 100 files" : "Firmware versions uploaded"}
        />
        <MetricCard
          label="Artifacts"
          icon={FolderArchive}
          href="/artifacts"
          loading={loading}
          value={overview?.artifacts ? countLabel(overview.artifacts.count, overview.artifacts.hasMore) : "—"}
          hint="Files in this scope, including firmware"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader title="Reverse-engineering progress" description="Across this scope's devices" />
          {loading ? (
            <LoadingState />
          ) : !overview.devices ? (
            <p className="px-5 py-8 text-sm text-slate-500">Devices couldn&apos;t be loaded.</p>
          ) : progress.total === 0 ? (
            <EmptyState
              icon={Cpu}
              title="No devices yet"
              description="Progress appears here once you register devices."
              action={
                <ButtonLink href="/devices" variant="secondary" size="sm">
                  Go to Devices
                </ButtonLink>
              }
            />
          ) : (
            <div className="p-5 flex flex-col sm:flex-row items-center gap-6">
              <ProgressDonut counts={progress.counts} total={progress.total} />
              <ul className="w-full space-y-3">
                {RE_ORDER.map((status) => (
                  <li key={status} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2 text-slate-700">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: RE_COLORS[status] }} aria-hidden="true" />
                      {REVERSE_ENGINEERING_STATUS_LABELS[status]}
                    </span>
                    <span className="tabular-nums text-slate-900 font-medium">
                      {progress.counts[status]}
                      <span className="text-slate-400 font-normal ml-1.5">{progress.percents[status]}%</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-3 overflow-hidden">
          <CardHeader
            title="Recently updated vulnerabilities"
            description="The latest changes to recorded CVEs"
            actions={
              <ButtonLink href="/vulnerabilities" variant="link" size="sm">
                View all <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </ButtonLink>
            }
          />
          {loading ? (
            <LoadingState />
          ) : !overview.cves ? (
            <p className="px-5 py-8 text-sm text-slate-500">Vulnerabilities couldn&apos;t be loaded.</p>
          ) : recent.length === 0 ? (
            <EmptyState
              icon={ShieldAlert}
              title="No vulnerabilities recorded yet"
              action={
                <ButtonLink href="/vulnerabilities" variant="secondary" size="sm" icon={Plus}>
                  Add a CVE
                </ButtonLink>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {recent.map((cve) => (
                <li key={cve.cveRecordId} className="px-5 py-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[13px] font-medium text-slate-900">{cve.cveId}</p>
                    <p className="text-xs text-slate-500 truncate">
                      {cve.deviceIds.length
                        ? cve.deviceIds.map((id) => deviceNames.get(id) ?? "Unknown device").join(", ")
                        : "No devices linked"}
                    </p>
                  </div>
                  <SeverityBadge severity={cve.severity} />
                  <span className="hidden sm:block text-xs text-slate-500 whitespace-nowrap w-24 text-right">
                    {formatDay(cve.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Quick actions" />
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <QuickAction href="/devices" icon={Cpu} title="Manage devices" text="Register devices and track their progress" />
          <QuickAction href="/firmware" icon={Upload} title="Upload firmware" text="Add a firmware version to a device" />
          <QuickAction href="/artifacts" icon={FolderArchive} title="Upload artifacts" text="Captures, logs, binaries and more" />
          <QuickAction href="/vulnerabilities" icon={ShieldAlert} title="Record a CVE" text="Link known vulnerabilities to devices" />
        </div>
      </Card>

      {!loading && overview.errors.length > 0 && (
        <div className="text-center">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  title,
  text,
}: {
  href: string;
  icon: typeof Cpu;
  title: string;
  text: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-lg border border-line p-3 hover:border-brand-200 hover:bg-brand-50/40 transition-colors"
    >
      <span className="h-9 w-9 shrink-0 rounded-lg bg-surface-sunken text-slate-600 group-hover:bg-brand-100 group-hover:text-brand-700 flex items-center justify-center">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900">{title}</span>
        <span className="block text-xs text-slate-500 mt-0.5">{text}</span>
      </span>
    </Link>
  );
}

/** A ring split by reverse-engineering status; the centre shows the device count. */
function ProgressDonut({ counts, total }: { counts: Record<ReverseEngineeringStatus, number>; total: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" role="img" aria-label="Reverse-engineering progress">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#eef2f7" strokeWidth="12" />
        {RE_ORDER.map((status) => {
          const length = total ? (counts[status] / total) * circumference : 0;
          const segment = (
            <circle
              key={status}
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke={RE_COLORS[status]}
              strokeWidth="12"
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return length > 0 ? segment : null;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold text-slate-900 tabular-nums">{total}</span>
        <span className="text-2xs uppercase tracking-wider text-slate-500">device{total === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}
