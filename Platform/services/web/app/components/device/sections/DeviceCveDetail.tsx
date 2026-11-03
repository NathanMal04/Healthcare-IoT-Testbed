"use client";

import { createContext, useCallback, useContext, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { Cve } from "@/lib/cves";
import { cveHref, deviceHref } from "@/lib/routes";
import CveDetails from "@/app/components/CveDetails";
import { ButtonLink } from "@/app/components/ui";

/** Tells the page the open CVE's ID once it has loaded (for the top bar's breadcrumb). */
const CveLabelContext = createContext<(label: string | undefined) => void>(() => undefined);

/**
 * A linked CVE's details, opened from the device's Vulnerabilities section
 * (`cve=` in the URL, so Back returns to the list). Deleting it returns to
 * the list. Its place in the device is shown by the top bar's breadcrumb.
 */
export default function DeviceCveDetail({
  deviceId,
  cveRecordId,
  onChanged,
  onDeleted,
  onLabel,
}: {
  deviceId: string;
  cveRecordId: string;
  onChanged: (cve: Cve) => void;
  onDeleted: (cveRecordId: string) => void;
  /** The CVE ID of `cveRecordId`, once known. */
  onLabel: (cveRecordId: string, label: string | undefined) => void;
}) {
  const router = useRouter();
  const reportLabel = useCallback((label: string | undefined) => onLabel(cveRecordId, label), [onLabel, cveRecordId]);
  return (
    <CveLabelContext.Provider value={reportLabel}>
      <CveDetails
        key={cveRecordId}
        cveRecordId={cveRecordId}
        Frame={DeviceCveFrame}
        backAction={
          <ButtonLink href={deviceHref(deviceId, "cves")} variant="secondary" size="sm">
            Back to linked vulnerabilities
          </ButtonLink>
        }
        onChanged={onChanged}
        onDeleted={(deleted) => {
          onDeleted(deleted);
          router.push(deviceHref(deviceId, "cves"));
        }}
      />
    </CveLabelContext.Provider>
  );
}

/** Keeps a linked CVE's details inside the device: the way back is its Vulnerabilities list. */
function DeviceCveFrame({ cveId, children }: { cveId?: string; children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const deviceId = searchParams.get("id") ?? "";
  const cveRecordId = searchParams.get("cve") ?? "";
  const listHref = deviceHref(deviceId, "cves");
  const reportLabel = useContext(CveLabelContext);
  useEffect(() => {
    reportLabel(cveId);
  }, [cveId, reportLabel]);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <Link
          href={listHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to linked vulnerabilities
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
