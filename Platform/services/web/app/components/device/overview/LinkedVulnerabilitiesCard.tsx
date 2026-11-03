"use client";

import { useState } from "react";
import Link from "next/link";
import { Link2, ShieldCheck } from "lucide-react";
import type { Device } from "@/lib/devices";
import { SEVERITY_LABELS, type Cve, type CveSummary } from "@/lib/cves";
import { severityDistribution, topCves } from "@/lib/deviceOverview";
import { deviceHref } from "@/lib/routes";
import CveLinkExplorer from "@/app/components/CveLinkExplorer";
import { Alert, Button, ButtonLink, Card, CardHeader, SeverityBadge, SkeletonText, focusRing } from "@/app/components/ui";

const SHOWN = 5;

const SEVERITY_CHIP: Record<string, string> = {
  critical: "bg-severity-critical-bg text-severity-critical",
  high: "bg-severity-high-bg text-severity-high",
  medium: "bg-severity-medium-bg text-severity-medium",
  low: "bg-severity-low-bg text-severity-low",
};

/**
 * The CVEs linked to the device: how many of each severity, the most severe
 * few (each opening its details inside the device, the existing deep link),
 * View all, and Link CVEs for users who may change the device's links.
 */
export default function LinkedVulnerabilitiesCard({
  device,
  allCves,
  deviceCves,
  error,
  loading,
  devices,
  devicesError,
  canLink,
  listHref,
  onRetry,
  onChanged,
}: {
  device: Device;
  /** Every CVE of the scope (null until loaded); the link explorer chooses from these. */
  allCves: CveSummary[] | null;
  deviceCves: CveSummary[];
  error: string | null;
  loading: boolean;
  devices: Device[] | null;
  devicesError: string | null;
  canLink: boolean;
  listHref: string;
  onRetry: () => void;
  onChanged: (cve: Cve) => void;
}) {
  const [exploring, setExploring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loaded = allCves !== null;
  const shown = topCves(deviceCves, SHOWN);

  return (
    <Card>
      <CardHeader
        title="Linked vulnerabilities"
        description={loaded ? `${deviceCves.length} linked to this device` : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={listHref} variant="secondary" size="sm">
              View all
            </ButtonLink>
            {canLink && (
              <Button
                size="sm"
                icon={Link2}
                onClick={() => {
                  setNotice(null);
                  setExploring(true);
                }}
                disabled={!loaded}
              >
                Link CVEs
              </Button>
            )}
          </div>
        }
      />
      <div className="p-5">
        {notice && (
          <Alert tone="success" className="mb-4" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        {error && !loaded ? (
          <div className="space-y-2">
            <p className="text-meta text-danger-700">{error}</p>
            <Button variant="secondary" size="sm" onClick={onRetry} disabled={loading}>
              {loading ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : !loaded ? (
          <SkeletonText lines={4} />
        ) : deviceCves.length === 0 ? (
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" aria-hidden="true" />
            <p className="text-sm text-slate-500">
              No CVEs linked to this device.
              {canLink ? " Link one from those recorded in this scope." : ""}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <ul className="flex flex-wrap gap-2" aria-label="Linked CVEs by severity">
              {severityDistribution(deviceCves).map(({ severity, count }) => (
                <li
                  key={severity}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-meta font-medium ${
                    count > 0 ? SEVERITY_CHIP[severity] : "bg-surface-muted text-slate-400"
                  }`}
                >
                  {SEVERITY_LABELS[severity]}
                  <span className="font-semibold tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {shown.map((cve) => (
                <li key={cve.cveRecordId}>
                  <Link
                    href={deviceHref(device.deviceId, "cves", { cve: cve.cveRecordId })}
                    scroll={false}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-surface-muted ${focusRing}`}
                  >
                    <span className="font-mono text-sm font-medium text-brand-700">{cve.cveId}</span>
                    <SeverityBadge severity={cve.severity} />
                    <span className="ml-auto text-meta tabular-nums text-slate-600">
                      {cve.cvssScore !== null ? (
                        <>
                          CVSS <span className="font-semibold text-slate-900">{cve.cvssScore}</span>
                          {cve.cvssVersion && <span className="text-slate-400"> v{cve.cvssVersion}</span>}
                        </>
                      ) : (
                        <span className="text-slate-400">No CVSS score</span>
                      )}
                    </span>
                    {cve.description && <span className="w-full truncate text-meta text-slate-500">{cve.description}</span>}
                  </Link>
                </li>
              ))}
            </ul>
            {deviceCves.length > shown.length && (
              <p className="text-meta text-slate-500">
                Showing the {shown.length} most severe of {deviceCves.length}.{" "}
                <Link href={listHref} scroll={false} className={`font-medium text-brand-700 hover:text-brand-800 ${focusRing}`}>
                  View all
                </Link>
              </p>
            )}
          </div>
        )}
      </div>

      {exploring && (
        <CveLinkExplorer
          device={device}
          cves={allCves}
          error={error}
          devices={devices}
          devicesError={devicesError}
          refreshing={loading}
          onRefresh={onRetry}
          onLinked={(linked) => linked.forEach((linkedCve) => onChanged(linkedCve))}
          onDone={(count) => {
            setExploring(false);
            setNotice(`Linked ${count} CVE${count === 1 ? "" : "s"} to ${device.name}.`);
          }}
          onClose={() => setExploring(false)}
        />
      )}
    </Card>
  );
}
