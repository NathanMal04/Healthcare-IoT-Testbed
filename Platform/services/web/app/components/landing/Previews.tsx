import { Cpu, FolderArchive, Microchip, ShieldAlert, type LucideIcon } from "lucide-react";
import { Badge, ReStatusBadge, SeverityBadge, StatusBadge } from "@/app/components/ui/Badge";
import { BrandLogo } from "@/app/components/shell/BrandMark";
import { NAV_SECTIONS, SYSTEM_ITEMS } from "@/app/components/shell/navigation";
import { REVERSE_ENGINEERING_STATUS_LABELS, type ReverseEngineeringStatus } from "@/lib/reverseEngineering";
import { SAMPLE_CVES, SAMPLE_DEVICES, SAMPLE_RE_COUNTS, SAMPLE_RUNS } from "./sampleData";

// Static stand-ins for the app's pages, built from the same badges and
// surfaces, for the landing page. Nothing here fetches or links anywhere.

/** A browser window around a miniature app: navy sidebar plus content. */
export function AppFrame({ path, active, children }: { path: string; active: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden bg-white ring-1 ring-black/5 shadow-pop">
      <div className="h-9 px-3 flex items-center gap-3 bg-surface-sunken border-b border-line">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        </span>
        <span className="flex-1 max-w-xs mx-auto h-5 rounded-md bg-white text-2xs text-slate-500 flex items-center justify-center truncate">
          vzoniq.com{path}
        </span>
      </div>
      <div className="flex">
        <div className="hidden md:flex w-44 shrink-0 flex-col bg-navy-900 text-white py-3 px-2" aria-hidden="true">
          <div className="flex items-center gap-2 px-2 pb-3 mb-2 border-b border-white/5">
            <BrandLogo className="h-6 w-6" />
            <span className="text-[13px] font-semibold">Vzoniq</span>
          </div>
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="mb-3">
              <p className="px-2 mb-1 text-[9px] font-semibold uppercase tracking-wider text-navy-300/80">{section.label}</p>
              {section.items.map(({ href, label, icon: Icon }) => (
                <div
                  key={href}
                  className={`flex items-center gap-2 px-2 h-7 rounded-md text-[11px] ${
                    label === active ? "bg-navy-700 text-white shadow-[inset_2px_0_0_0_#3a74ec]" : "text-navy-200"
                  }`}
                >
                  <Icon className={`h-3 w-3 ${label === active ? "text-brand-200" : "text-navy-300"}`} />
                  {label}
                </div>
              ))}
            </div>
          ))}
          <div className="mt-auto pt-2 border-t border-white/5">
            {SYSTEM_ITEMS.map(({ href, label, icon: Icon }) => (
              <div
                key={href}
                className={`flex items-center gap-2 px-2 h-7 rounded-md text-[11px] ${
                  label === active ? "bg-navy-700 text-white" : "text-navy-200"
                }`}
              >
                <Icon className="h-3 w-3 text-navy-300" />
                {label}
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 min-w-0 bg-surface-muted p-4 sm:p-5 text-left">{children}</div>
      </div>
    </div>
  );
}

function PreviewHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <p className="text-base sm:text-lg font-semibold text-slate-900 tracking-tight">{title}</p>
      <p className="text-xs text-slate-500 mt-0.5">{description}</p>
    </div>
  );
}

function PreviewCard({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-xl border border-line shadow-card overflow-hidden ${className}`}>
      {title && <p className="px-4 py-3 border-b border-line text-xs font-semibold text-slate-800">{title}</p>}
      {children}
    </div>
  );
}

function Metric({ label, value, hint, icon: Icon }: { label: string; value: string; hint: string; icon: LucideIcon }) {
  return (
    <div className="bg-white rounded-xl border border-line shadow-card p-3">
      <div className="flex items-center justify-between">
        <p className="text-2xs font-medium text-slate-500">{label}</p>
        <span className="h-6 w-6 rounded-md bg-brand-50 text-brand-600 flex items-center justify-center">
          <Icon className="h-3 w-3" aria-hidden="true" />
        </span>
      </div>
      <p className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">{value}</p>
      <p className="text-2xs text-slate-500 truncate">{hint}</p>
    </div>
  );
}

// The same colours as the dashboard's progress ring.
const RE_COLORS: Record<ReverseEngineeringStatus, string> = {
  complete: "#10b981",
  in_progress: "#f59e0b",
  not_started: "#cbd5e1",
};
const RE_ORDER: ReverseEngineeringStatus[] = ["complete", "in_progress", "not_started"];

function ProgressRing() {
  const total = SAMPLE_DEVICES.length;
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="p-4 flex items-center gap-4">
      <div className="relative h-24 w-24 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="#eef2f7" strokeWidth="12" />
          {RE_ORDER.map((status) => {
            const length = (SAMPLE_RE_COUNTS[status] / total) * circumference;
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
          <span className="text-lg font-semibold text-slate-900 tabular-nums">{total}</span>
          <span className="text-[9px] uppercase tracking-wider text-slate-500">devices</span>
        </div>
      </div>
      <ul className="w-full space-y-2">
        {RE_ORDER.map((status) => (
          <li key={status} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-slate-700">
              <span className="h-2 w-2 rounded-full" style={{ background: RE_COLORS[status] }} aria-hidden="true" />
              {REVERSE_ENGINEERING_STATUS_LABELS[status]}
            </span>
            <span className="tabular-nums font-medium text-slate-900">{SAMPLE_RE_COUNTS[status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DashboardPreview() {
  return (
    <>
      <PreviewHeader title="Dashboard" description="Overview of your devices, firmware and vulnerability research" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Metric label="Devices" value={String(SAMPLE_DEVICES.length)} hint={`${SAMPLE_RE_COUNTS.complete} fully reverse-engineered`} icon={Cpu} />
        <Metric label="Vulnerabilities" value={String(SAMPLE_CVES.length)} hint="1 critical · 1 high" icon={ShieldAlert} />
        <Metric label="Firmware" value="6" hint="Firmware versions uploaded" icon={Microchip} />
        <Metric label="Artifacts" value="18" hint="Files in this scope" icon={FolderArchive} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 mt-3">
        <PreviewCard title="Reverse-engineering progress" className="lg:col-span-2">
          <ProgressRing />
        </PreviewCard>
        <PreviewCard title="Recently updated vulnerabilities" className="lg:col-span-3">
          <ul className="divide-y divide-line">
            {SAMPLE_CVES.map((cve) => (
              <li key={cve.cveId} className="px-4 py-2.5 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs font-medium text-slate-900">{cve.cveId}</p>
                  <p className="text-2xs text-slate-500 truncate">{cve.device}</p>
                </div>
                <SeverityBadge severity={cve.severity} />
              </li>
            ))}
          </ul>
        </PreviewCard>
      </div>
    </>
  );
}

function PreviewTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <PreviewCard>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="text-left bg-surface-muted border-b border-line">
              {headers.map((h, i) => (
                <th
                  key={h}
                  scope="col"
                  className={`py-2 text-2xs font-semibold uppercase tracking-wider text-slate-500 ${i === 0 ? "pl-4 pr-3" : "px-3"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">{children}</tbody>
        </table>
      </div>
    </PreviewCard>
  );
}

export function DevicesPreview() {
  return (
    <>
      <PreviewHeader title="Devices" description="The connected medical devices under analysis" />
      <PreviewTable headers={["Device", "Your access", "Reverse engineering"]}>
        {SAMPLE_DEVICES.map((d) => (
          <tr key={d.name}>
            <td className="py-2.5 pl-4 pr-3">
              <p className="font-medium text-slate-900">{d.name}</p>
              <p className="text-2xs text-slate-500">{d.type}</p>
            </td>
            <td className="py-2.5 px-3">
              <Badge tone={d.access === "Owner" ? "brand" : "neutral"}>{d.access}</Badge>
            </td>
            <td className="py-2.5 px-3">
              <ReStatusBadge status={d.status} />
            </td>
          </tr>
        ))}
      </PreviewTable>
    </>
  );
}

export function CvesPreview() {
  return (
    <>
      <PreviewHeader title="Vulnerabilities (CVE)" description="Known vulnerabilities recorded against your devices" />
      <PreviewTable headers={["CVE ID", "Severity", "CVSS", "Affected chipsets", "Devices"]}>
        {SAMPLE_CVES.map((cve) => (
          <tr key={cve.cveId}>
            <td className="py-2.5 pl-4 pr-3 font-mono font-medium text-slate-900 whitespace-nowrap">{cve.cveId}</td>
            <td className="py-2.5 px-3">
              <SeverityBadge severity={cve.severity} />
            </td>
            <td className="py-2.5 px-3 tabular-nums text-slate-700 whitespace-nowrap">{cve.cvss}</td>
            <td className="py-2.5 px-3 text-slate-600">{cve.chipsets}</td>
            <td className="py-2.5 px-3 text-slate-600">{cve.device}</td>
          </tr>
        ))}
      </PreviewTable>
    </>
  );
}

export function RunsPreview() {
  return (
    <>
      <PreviewHeader title="Runs" description="Scripts run in bulk over your artifacts, with per-job logs and outputs" />
      <PreviewTable headers={["Run", "Status", "Units"]}>
        {SAMPLE_RUNS.map((run) => (
          <tr key={run.name}>
            <td className="py-2.5 pl-4 pr-3">
              <p className="font-medium text-slate-900">{run.name}</p>
              <p className="text-2xs text-slate-500 font-mono">{run.script}</p>
            </td>
            <td className="py-2.5 px-3">
              <StatusBadge status={run.status} />
            </td>
            <td className="py-2.5 px-3 tabular-nums text-slate-700">{run.units}</td>
          </tr>
        ))}
      </PreviewTable>
    </>
  );
}
