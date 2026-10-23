import type { Severity } from "@/lib/cves";
import type { ReverseEngineeringStatus } from "@/lib/reverseEngineering";
import type { RunStatus } from "@/lib/runs";

// Illustrative rows for the landing page's product previews. They describe no
// real device, user or finding: CVE ids are placeholders (CVE-YYYY-…) and the
// figures are just the counts of these rows.

export interface SampleDevice {
  name: string;
  type: string;
  access: "Owner" | "Member";
  status: ReverseEngineeringStatus;
}

export const SAMPLE_DEVICES: SampleDevice[] = [
  { name: "Infusion pump · bench unit A", type: "Infusion pump", access: "Owner", status: "complete" },
  { name: "Patient monitor · bench unit B", type: "Patient monitor", access: "Owner", status: "in_progress" },
  { name: "Glucose meter gateway", type: "Gateway", access: "Member", status: "in_progress" },
  { name: "Pulse oximeter hub", type: "Bedside hub", access: "Member", status: "not_started" },
];

export interface SampleCve {
  cveId: string;
  severity: Severity;
  cvss: string;
  chipsets: string;
  device: string;
}

export const SAMPLE_CVES: SampleCve[] = [
  { cveId: "CVE-YYYY-0142", severity: "critical", cvss: "9.8 · v3.1", chipsets: "Example MCU", device: "Infusion pump · bench unit A" },
  { cveId: "CVE-YYYY-0377", severity: "high", cvss: "7.5 · v3.1", chipsets: "Example Wi-Fi SoC", device: "Patient monitor · bench unit B" },
  { cveId: "CVE-YYYY-1058", severity: "medium", cvss: "5.3 · v3.1", chipsets: "Example BLE radio", device: "Glucose meter gateway" },
];

export interface SampleRun {
  name: string;
  script: string;
  status: RunStatus;
  units: string;
}

export const SAMPLE_RUNS: SampleRun[] = [
  { name: "Firmware strings sweep", script: "extract-strings v3", status: "completed", units: "6 / 6" },
  { name: "Capture summary", script: "pcap-summary v1", status: "running", units: "3 / 8" },
  { name: "Entropy scan", script: "entropy-scan v2", status: "failed", units: "1 / 2" },
];

export const SAMPLE_RE_COUNTS: Record<ReverseEngineeringStatus, number> = SAMPLE_DEVICES.reduce(
  (acc, d) => ({ ...acc, [d.status]: acc[d.status] + 1 }),
  { complete: 0, in_progress: 0, not_started: 0 }
);
