// Links to pages that take their subject from the query string (the site is
// a static export, so there are no dynamic route segments).

/**
 * `cve` opens that linked CVE's details on the device's CVEs tab. The RE
 * Notebook has its own page: see notebookHref (a "notebook" tab here
 * redirects there).
 */
export function deviceHref(deviceId: string, tab?: string, options: { cve?: string } = {}): string {
  const params = new URLSearchParams({ id: deviceId });
  if (options.cve) {
    params.set("tab", "cves");
    params.set("cve", options.cve);
  } else if (tab) {
    params.set("tab", tab);
  }
  return `/devices/view?${params.toString()}`;
}

/** The device's RE Notebook workspace, optionally on a section or entry. */
export function notebookHref(deviceId: string, options: { section?: string | null; entry?: string | null } = {}): string {
  const params = new URLSearchParams({ id: deviceId });
  if (options.section) params.set("section", options.section);
  if (options.entry) params.set("entry", options.entry);
  return `/devices/notebook?${params.toString()}`;
}

/**
 * Where an older RE Notebook link to the device page
 * (/devices/view?id=…&tab=notebook[&entry=…]) now leads, or null for any
 * other device page link.
 */
export function legacyNotebookHref(params: URLSearchParams): string | null {
  const deviceId = params.get("id");
  if (!deviceId || params.get("tab") !== "notebook" || params.get("cve")) return null;
  return notebookHref(deviceId, { entry: params.get("entry") });
}

/** `edit` opens the page with its edit dialog showing. */
export function cveHref(cveRecordId: string, tab?: string, options: { edit?: boolean } = {}): string {
  const params = new URLSearchParams({ id: cveRecordId });
  if (tab) params.set("tab", tab);
  if (options.edit) params.set("edit", "1");
  return `/vulnerabilities/view?${params.toString()}`;
}
