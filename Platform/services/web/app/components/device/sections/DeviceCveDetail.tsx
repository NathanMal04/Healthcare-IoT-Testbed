"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronRight, ExternalLink } from "lucide-react";
import type { Cve } from "@/lib/cves";
import { cveHref, deviceHref } from "@/lib/routes";
import CveDetails from "@/app/components/CveDetails";
import { ButtonLink } from "@/app/components/ui";

/**
 * A linked CVE's details, opened from the device's CVEs section (`cve=` in
 * the URL, so Back returns to the list). Deleting it returns to the list.
 */
export default function DeviceCveDetail({
  deviceId,
  cveRecordId,
  onChanged,
  onDeleted,
}: {
  deviceId: string;
  cveRecordId: string;
  onChanged: (cve: Cve) => void;
  onDeleted: (cveRecordId: string) => void;
}) {
  const router = useRouter();
  return (
    <CveDetails
      key={cveRecordId}
      cveRecordId={cveRecordId}
      Frame={DeviceCveFrame}
      backAction={
        <ButtonLink href={deviceHref(deviceId, "cves")} variant="secondary" size="sm">
          Back to CVEs
        </ButtonLink>
      }
      onChanged={onChanged}
      onDeleted={(deleted) => {
        onDeleted(deleted);
        router.push(deviceHref(deviceId, "cves"));
      }}
    />
  );
}

/** Keeps a linked CVE's details inside the device: the way back is its CVE list. */
function DeviceCveFrame({ cveId, children }: { cveId?: string; children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const deviceId = searchParams.get("id") ?? "";
  const cveRecordId = searchParams.get("cve") ?? "";
  const listHref = deviceHref(deviceId, "cves");
  return (
    <div>
      {/* The top bar's breadcrumb is the page's navigation landmark; this trail is a visual aid. */}
      <div className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
        <Link href={listHref} className="hover:text-brand-700">
          CVEs
        </Link>
        {cveId && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
            <span className="font-mono text-slate-600">{cveId}</span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 mt-3 mb-4">
        <Link
          href={listHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to CVEs
        </Link>
        {cveRecordId && (
          <Link
            href={cveHref(cveRecordId)}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700"
          >
            Open in Vulnerabilities
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}
