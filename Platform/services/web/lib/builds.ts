import { apiRequest } from "@/lib/api";
import { sha256File } from "@/lib/artifacts";

// --- Shared ------------------------------------------------------------------

export type BuildStatus = "pending" | "building" | "ready" | "build_failed" | "rejected";
export type BuildKind = "modules" | "environments";

export interface BuildVersion {
  version: number;
  status: BuildStatus;
  statusReason?: string;
  statusUpdatedAt?: string;
  imageUri?: string;
  createdAt: string;
}

export function getBuildLog(kind: BuildKind, id: string, version: number): Promise<{ lines: string[]; note?: string }> {
  return apiRequest("GET", `/${kind}/${encodeURIComponent(id)}/versions/${version}/log`);
}

export function getPackages(kind: BuildKind, id: string, version: number): Promise<{ pip: string | null; dpkg: string | null }> {
  return apiRequest("GET", `/${kind}/${encodeURIComponent(id)}/versions/${version}/packages`);
}

// --- Environments --------------------------------------------------------------

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
}

export interface Environment {
  envId: string;
  name: string;
  description?: string;
  base?: string;
  latestVersion: number;
  latestReadyVersion?: number;
  platform?: boolean;
  createdAt?: string;
}

export interface EnvironmentVersion extends BuildVersion {
  envId: string;
  catalogItems?: string[];
  parentVersion?: number;
  basedOn?: string;
}

export async function listEnvironments(): Promise<Environment[]> {
  return (await apiRequest<{ environments: Environment[] }>("GET", "/environments")).environments;
}

export async function getCatalog(): Promise<CatalogItem[]> {
  return (await apiRequest<{ items: CatalogItem[] }>("GET", "/environments/catalog")).items;
}

export function getEnvironment(envId: string): Promise<{ environment: Environment; versions: EnvironmentVersion[] }> {
  return apiRequest("GET", `/environments/${encodeURIComponent(envId)}`);
}

export function createEnvironment(input: {
  name: string;
  description?: string;
  base: string;
  catalogItems: string[];
}): Promise<{ environment: Environment; version: EnvironmentVersion }> {
  return apiRequest("POST", "/environments", { body: input });
}

export function createEnvironmentVersion(
  envId: string,
  input: { catalogItems: string[]; fromVersion?: number }
): Promise<{ version: EnvironmentVersion }> {
  return apiRequest("POST", `/environments/${encodeURIComponent(envId)}/versions`, { body: input });
}

// --- Scripts (modules) ----------------------------------------------------------

export type ScriptLevel = "L1" | "L2" | "L3";

export interface Module {
  moduleId: string;
  name: string;
  description?: string;
  runtime: "cloud" | "local";
  latestVersion: number;
  latestReadyVersion?: number;
  createdAt: string;
}

export interface ModuleVersion extends BuildVersion {
  moduleId: string;
  runtime: "cloud" | "local";
  level?: ScriptLevel;
  envId?: string;
  envVersion?: number;
  originalFilename: string;
  sizeBytes: number;
  command?: string[];
}

export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export async function listModules(): Promise<Module[]> {
  return (await apiRequest<{ modules: Module[] }>("GET", "/modules")).modules;
}

export function getModule(moduleId: string): Promise<{ module: Module; versions: ModuleVersion[] }> {
  return apiRequest("GET", `/modules/${encodeURIComponent(moduleId)}`);
}

export async function createModule(input: {
  name: string;
  description?: string;
  runtime: "cloud" | "local";
}): Promise<Module> {
  return (await apiRequest<{ module: Module }>("POST", "/modules", { body: input })).module;
}

export type SourceUploadStage = "hashing" | "reserving" | "uploading" | "validating";

/**
 * Uploads a new version of a script and starts its build. Resolves with the
 * version as the server left it: building, ready (local scripts) or rejected.
 */
export async function uploadModuleVersion(
  moduleId: string,
  file: File,
  options: { level?: ScriptLevel; envId?: string; envVersion?: number },
  onStage?: (stage: SourceUploadStage) => void
): Promise<ModuleVersion> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error("Script uploads are limited to 50 MB");
  onStage?.("hashing");
  const sha256 = await sha256File(file);

  onStage?.("reserving");
  const created = await apiRequest<{
    version: ModuleVersion;
    upload: { url: string; fields: Record<string, string> };
  }>("POST", `/modules/${encodeURIComponent(moduleId)}/versions`, {
    body: { ...options, originalFilename: file.name, sizeBytes: file.size, sha256 },
  });

  onStage?.("uploading");
  const form = new FormData();
  for (const [key, value] of Object.entries(created.upload.fields)) form.append(key, value);
  form.append("file", file);
  const response = await fetch(created.upload.url, { method: "POST", body: form });
  if (!response.ok) throw new Error(`S3 upload failed with status ${response.status}`);

  onStage?.("validating");
  const done = await apiRequest<{ version: ModuleVersion }>(
    "POST",
    `/modules/${encodeURIComponent(moduleId)}/versions/${created.version.version}/complete`
  );
  return done.version;
}

export async function getSourceDownloadUrl(moduleId: string, version: number): Promise<string> {
  return (
    await apiRequest<{ url: string }>("GET", `/modules/${encodeURIComponent(moduleId)}/versions/${version}/download`)
  ).url;
}
