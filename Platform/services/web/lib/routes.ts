// Links to pages that take their subject from the query string (the site is
// a static export, so there are no dynamic route segments).

/** `cve` opens that linked CVE's details on the device's CVEs tab. */
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

/** `edit` opens the page with its edit dialog showing. */
export function cveHref(cveRecordId: string, tab?: string, options: { edit?: boolean } = {}): string {
  const params = new URLSearchParams({ id: cveRecordId });
  if (tab) params.set("tab", tab);
  if (options.edit) params.set("edit", "1");
  return `/vulnerabilities/view?${params.toString()}`;
}
