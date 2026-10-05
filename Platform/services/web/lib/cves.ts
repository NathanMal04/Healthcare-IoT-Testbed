import { ApiError, apiRequest } from "@/lib/api";

// --- Types --------------------------------------------------------------------

/** Most severe first: the order the UI lists them in. */
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const CVSS_VERSIONS = ["2.0", "3.0", "3.1", "4.0"] as const;
export type CvssVersion = (typeof CVSS_VERSIONS)[number];

// The backend's limits (cves-api), checked here first so the form can say
// what is wrong before anything is sent.
export const MAX_DEVICES_PER_CVE = 40;
export const DESCRIPTION_MAX_LENGTH = 4000;
export const CHIPSETS_MAX = 20;
export const CHIPSET_MAX_LENGTH = 64;
export const REFERENCES_MAX = 20;
export const REFERENCE_MAX_LENGTH = 2048;
export const CVSS_MAX = 10;
const FIRST_CVE_YEAR = 1999;

/** A CVE as GET /cves lists it: everything except references. */
export interface CveSummary {
  cveRecordId: string;
  cveId: string;
  severity: Severity;
  cvssScore: number | null;
  cvssVersion: CvssVersion | null;
  description: string | null;
  affectedChipsets: string[];
  /** Linked devices of the CVE's own scope; [] when none. */
  deviceIds: string[];
  /** Set only on workspace CVEs. */
  workspaceId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** A CVE as GET /cves/{id} and every write return it. */
export interface Cve extends CveSummary {
  references: string[];
}

export interface NewCve {
  cveId: string;
  severity: Severity;
  cvssScore?: number;
  cvssVersion?: CvssVersion;
  description?: string;
  affectedChipsets?: string[];
  references?: string[];
  /** Records the CVE in this workspace; omitted for a personal CVE. */
  workspaceId?: string;
}

/** A PATCH: only the fields that change. null clears an optional field. Never deviceIds. */
export type CveChanges = Partial<{
  severity: Severity;
  cvssScore: number | null;
  cvssVersion: CvssVersion | null;
  description: string | null;
  affectedChipsets: string[] | null;
  references: string[] | null;
}>;

export interface CveLinkResult {
  cve: Cve;
  /** false when the device was already linked (or already unlinked). */
  changed: boolean;
}

export interface DeletedCve {
  cveRecordId: string;
  cveId: string;
  deviceCount: number;
}

// --- API ----------------------------------------------------------------------

function cvePath(cveRecordId: string): string {
  return `/cves/${encodeURIComponent(cveRecordId)}`;
}

function devicePath(cveRecordId: string, deviceId: string): string {
  return `${cvePath(cveRecordId)}/devices/${encodeURIComponent(deviceId)}`;
}

// Lists default to [] so callers never see a missing array.
function toSummary(raw: CveSummary): CveSummary {
  return {
    ...raw,
    description: raw.description ?? null,
    affectedChipsets: raw.affectedChipsets ?? [],
    deviceIds: raw.deviceIds ?? [],
  };
}

function toCve(raw: Cve): Cve {
  return { ...toSummary(raw), references: raw.references ?? [] };
}

/** Personal CVEs, or a workspace's when workspaceId is given. Newest first. */
export async function listCves(workspaceId?: string): Promise<CveSummary[]> {
  const data = await apiRequest<{ cves: CveSummary[] }>("GET", "/cves", { query: { workspaceId } });
  return data.cves.map(toSummary);
}

export async function getCve(cveRecordId: string): Promise<Cve> {
  return toCve((await apiRequest<{ cve: Cve }>("GET", cvePath(cveRecordId))).cve);
}

export async function createCve(input: NewCve): Promise<Cve> {
  return toCve((await apiRequest<{ cve: Cve }>("POST", "/cves", { body: input })).cve);
}

export async function updateCve(cveRecordId: string, changes: CveChanges): Promise<Cve> {
  return toCve((await apiRequest<{ cve: Cve }>("PATCH", cvePath(cveRecordId), { body: changes })).cve);
}

/** Deletes the CVE record and its device links; the devices themselves are untouched. */
export async function deleteCve(cveRecordId: string): Promise<DeletedCve> {
  return (await apiRequest<{ deleted: DeletedCve }>("DELETE", cvePath(cveRecordId))).deleted;
}

export async function linkCveDevice(cveRecordId: string, deviceId: string): Promise<CveLinkResult> {
  const result = await apiRequest<CveLinkResult>("PUT", devicePath(cveRecordId, deviceId));
  return { cve: toCve(result.cve), changed: result.changed };
}

export async function unlinkCveDevice(cveRecordId: string, deviceId: string): Promise<CveLinkResult> {
  const result = await apiRequest<CveLinkResult>("DELETE", devicePath(cveRecordId, deviceId));
  return { cve: toCve(result.cve), changed: result.changed };
}

// --- CVE ids ------------------------------------------------------------------

// U+2010..U+2015 and U+2212: hyphens and dashes that pasted ids often contain.
const UNICODE_HYPHENS = /[‐-―−]/g;
// ASCII digits only, as the backend requires.
const CVE_ID_PATTERN = /^CVE-([0-9]{4})-([0-9]{4,19})$/;

/** The backend's canonical form: trimmed, Unicode hyphens as "-", uppercase. Not validated. */
export function normalizeCveId(raw: string): string {
  return raw.trim().replace(UNICODE_HYPHENS, "-").toUpperCase();
}

/** Why the id would be refused, or null if it is valid. */
export function cveIdError(raw: string, now: Date = new Date()): string | null {
  const cveId = normalizeCveId(raw);
  if (!cveId) return "CVE ID is required";
  const match = CVE_ID_PATTERN.exec(cveId);
  if (!match) return "Use the official form, e.g. CVE-2021-37584";
  const year = Number(match[1]);
  const lastYear = now.getUTCFullYear() + 1;
  if (year < FIRST_CVE_YEAR || year > lastYear) return `The year must be between ${FIRST_CVE_YEAR} and ${lastYear}`;
  return null;
}

// --- Form ---------------------------------------------------------------------

/** What the add/edit form holds. Text inputs stay strings until submitted. */
export interface CveFormValues {
  cveId: string;
  severity: Severity | "";
  cvssScore: string;
  cvssVersion: CvssVersion | "";
  description: string;
  affectedChipsets: string[];
  references: string[];
  /** Devices to link after creating (add only). */
  deviceIds: string[];
}

export type CveFormErrors = Partial<Record<keyof CveFormValues, string>>;

export const EMPTY_CVE_FORM: CveFormValues = {
  cveId: "",
  severity: "",
  cvssScore: "",
  cvssVersion: "",
  description: "",
  affectedChipsets: [],
  references: [],
  deviceIds: [],
};

/** The form for editing an existing CVE. */
export function cveFormValues(cve: Cve): CveFormValues {
  return {
    cveId: cve.cveId,
    severity: cve.severity,
    cvssScore: cve.cvssScore === null ? "" : String(cve.cvssScore),
    cvssVersion: cve.cvssVersion ?? "",
    description: cve.description ?? "",
    affectedChipsets: [...cve.affectedChipsets],
    references: [...cve.references],
    deviceIds: [...cve.deviceIds],
  };
}

const SCORE_PATTERN = /^(\d+(\.\d*)?|\.\d+)$/;

/** The score as a number, null when blank, NaN when not a plain decimal. */
export function parseCvssScore(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  return SCORE_PATTERN.test(text) ? Number(text) : NaN;
}

function hasControlChars(text: string, allowed = ""): boolean {
  return [...text].some((c) => {
    const code = c.charCodeAt(0);
    return (code < 0x20 || (code >= 0x7f && code < 0xa0)) && !allowed.includes(c);
  });
}

/** True for an http:// or https:// URL with a host, as the backend accepts. */
export function isWebUrl(raw: string): boolean {
  const url = raw.trim();
  if (!url || url.length > REFERENCE_MAX_LENGTH || /\s/.test(url) || hasControlChars(url)) return false;
  // Both "//" and a host are required: "https:example.com" parses, but the backend refuses it.
  if (!/^https?:\/\/[^/?#]/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Field-by-field messages for the form, using the backend's rules. Empty when
 * the form can be sent. The CVE ID is only checked when creating; it can't change.
 */
export function validateCveForm(
  values: CveFormValues,
  options: { mode: "create" | "edit"; now?: Date } = { mode: "create" }
): CveFormErrors {
  const errors: CveFormErrors = {};
  if (options.mode === "create") {
    const idError = cveIdError(values.cveId, options.now);
    if (idError) errors.cveId = idError;
  }
  if (!values.severity) errors.severity = "Choose a severity";

  const score = parseCvssScore(values.cvssScore);
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > CVSS_MAX)) {
    errors.cvssScore = "CVSS score must be a number from 0 to 10";
  }

  const description = values.description.trim();
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    errors.description = `Description is too long (${description.length} of ${DESCRIPTION_MAX_LENGTH} characters)`;
  } else if (hasControlChars(description, "\n\r\t")) {
    errors.description = "Description contains unsupported control characters";
  }

  const chipsets = values.affectedChipsets.map((c) => c.trim());
  if (chipsets.length > CHIPSETS_MAX) {
    errors.affectedChipsets = `At most ${CHIPSETS_MAX} chipsets`;
  } else if (chipsets.some((c) => !c || c.length > CHIPSET_MAX_LENGTH || hasControlChars(c))) {
    errors.affectedChipsets = `Each chipset must be 1–${CHIPSET_MAX_LENGTH} characters`;
  }

  const references = values.references.map((r) => r.trim()).filter(Boolean);
  if (references.length > REFERENCES_MAX) {
    errors.references = `At most ${REFERENCES_MAX} references`;
  } else if (references.some((r) => !isWebUrl(r))) {
    errors.references = "References must be http:// or https:// links";
  }

  if (values.deviceIds.length > MAX_DEVICES_PER_CVE) {
    errors.deviceIds = `At most ${MAX_DEVICES_PER_CVE} devices per CVE`;
  }
  return errors;
}

/** Adds chipsets typed as "A, B" (or one per line), trimmed, skipping case-insensitive duplicates. */
export function addChipsets(current: string[], raw: string): string[] {
  const result = [...current];
  const seen = new Set(current.map((c) => c.toLowerCase()));
  for (const part of raw.split(/[,\n]/)) {
    const chipset = part.trim();
    if (chipset && !seen.has(chipset.toLowerCase())) {
      seen.add(chipset.toLowerCase());
      result.push(chipset);
    }
  }
  return result;
}

function cleanReferences(references: string[]): string[] {
  return [...new Set(references.map((r) => r.trim()).filter(Boolean))];
}

/** The POST body for a validated form. Empty optional fields are left out. */
export function toNewCve(values: CveFormValues, workspaceId?: string): NewCve {
  const input: NewCve = { cveId: normalizeCveId(values.cveId), severity: values.severity as Severity };
  const score = parseCvssScore(values.cvssScore);
  if (score !== null) input.cvssScore = score;
  if (values.cvssVersion) input.cvssVersion = values.cvssVersion;
  const description = values.description.trim();
  if (description) input.description = description;
  const chipsets = addChipsets([], values.affectedChipsets.join(","));
  if (chipsets.length) input.affectedChipsets = chipsets;
  const references = cleanReferences(values.references);
  if (references.length) input.references = references;
  if (workspaceId) input.workspaceId = workspaceId;
  return input;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The PATCH body for an edited form: only fields that differ from the CVE, null to clear. */
export function cveChanges(original: Cve, values: CveFormValues): CveChanges {
  const changes: CveChanges = {};
  if (values.severity && values.severity !== original.severity) changes.severity = values.severity;

  const score = parseCvssScore(values.cvssScore);
  if (score !== original.cvssScore) changes.cvssScore = score;

  const version = values.cvssVersion || null;
  if (version !== original.cvssVersion) changes.cvssVersion = version;

  const description = values.description.trim() || null;
  if (description !== (original.description || null)) changes.description = description;

  const chipsets = addChipsets([], values.affectedChipsets.join(","));
  if (!sameList(chipsets, original.affectedChipsets)) changes.affectedChipsets = chipsets.length ? chipsets : null;

  const references = cleanReferences(values.references);
  if (!sameList(references, original.references)) changes.references = references.length ? references : null;
  return changes;
}

// --- Search -------------------------------------------------------------------

/** Device filter value for CVEs without any linked device. */
export const NO_DEVICES = "__none__";

export interface CveFilters {
  /** Free text: every word must match the CVE ID, description, a chipset or a linked device's name. */
  text: string;
  severity: Severity | "";
  /** "" for all, NO_DEVICES, or a deviceId. */
  device: string;
}

export const EMPTY_FILTERS: CveFilters = { text: "", severity: "", device: "" };

function fold(text: string): string {
  return text.replace(UNICODE_HYPHENS, "-").toLowerCase();
}

export function hasActiveFilters(filters: CveFilters): boolean {
  return filters.text.trim() !== "" || filters.severity !== "" || filters.device !== "";
}

/** The CVEs matching the filters, in their original order. */
export function filterCves<T extends CveSummary>(
  cves: T[],
  filters: CveFilters,
  deviceNames: ReadonlyMap<string, string>
): T[] {
  const words = fold(filters.text).split(/\s+/).filter(Boolean);
  return cves.filter((cve) => {
    if (filters.severity && cve.severity !== filters.severity) return false;
    if (filters.device === NO_DEVICES && cve.deviceIds.length > 0) return false;
    if (filters.device && filters.device !== NO_DEVICES && !cve.deviceIds.includes(filters.device)) return false;
    if (!words.length) return true;
    const haystack = fold(
      [
        cve.cveId,
        cve.description ?? "",
        ...cve.affectedChipsets,
        ...cve.deviceIds.map((id) => deviceNames.get(id) ?? ""),
      ].join("\n")
    );
    return words.every((word) => haystack.includes(word));
  });
}

// --- Create, then link ------------------------------------------------------------

export interface LinkFailure {
  deviceId: string;
  message: string;
}

export interface LinkOutcome {
  /** The CVE after the last successful link (or as created), or null if none succeeded and none was given. */
  cve: Cve | null;
  failed: LinkFailure[];
}

export interface CveWriteApi {
  createCve: typeof createCve;
  linkCveDevice: typeof linkCveDevice;
}

const DEFAULT_API: CveWriteApi = { createCve, linkCveDevice };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status < 500) return err.message;
  return "Couldn't reach the server";
}

/**
 * Links the devices one at a time (parallel links of one CVE would conflict),
 * collecting failures instead of stopping. Linking is idempotent, so a retry
 * may include devices that are already linked.
 */
export async function linkDevices(
  cveRecordId: string,
  deviceIds: string[],
  options: { onProgress?: (done: number, total: number) => void; api?: CveWriteApi; cve?: Cve } = {}
): Promise<LinkOutcome> {
  const api = options.api ?? DEFAULT_API;
  const ids = [...new Set(deviceIds)];
  let cve = options.cve ?? null;
  const failed: LinkFailure[] = [];
  for (const [index, deviceId] of ids.entries()) {
    options.onProgress?.(index, ids.length);
    try {
      cve = (await api.linkCveDevice(cveRecordId, deviceId)).cve;
    } catch (err) {
      failed.push({ deviceId, message: errorMessage(err) });
    }
  }
  options.onProgress?.(ids.length, ids.length);
  return { cve, failed };
}

/**
 * Creates the CVE, then links the selected devices. If creating fails the
 * error is thrown and nothing was written; if some links fail the CVE is kept
 * and the failures are returned (never rolled back).
 */
export async function createCveWithDevices(
  input: NewCve,
  deviceIds: string[],
  options: { onProgress?: (done: number, total: number) => void; api?: CveWriteApi } = {}
): Promise<{ cve: Cve; failed: LinkFailure[] }> {
  const api = options.api ?? DEFAULT_API;
  const created = await api.createCve(input);
  if (!deviceIds.length) return { cve: created, failed: [] };
  const outcome = await linkDevices(created.cveRecordId, deviceIds, { ...options, api, cve: created });
  return { cve: outcome.cve ?? created, failed: outcome.failed };
}

// --- Errors -------------------------------------------------------------------

/** The existing record's id when creating failed because the CVE ID is already recorded in the scope. */
export function duplicateCveRecordId(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const id = err.details.cveRecordId;
  return typeof id === "string" ? id : null;
}

/** True when the CVE (or the caller's access to it) is gone. */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** A message to show: the backend's own for 4xx, a generic one for 5xx and network failures. */
export function cveErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status < 500) return err.message;
  return `${fallback}. Please try again.`;
}
