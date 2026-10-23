// Links to pages that take their subject from the query string (the site is
// a static export, so there are no dynamic route segments).

export function deviceHref(deviceId: string, tab?: string): string {
  const params = new URLSearchParams({ id: deviceId });
  if (tab) params.set("tab", tab);
  return `/devices/view?${params.toString()}`;
}

/** `edit` opens the page with its edit dialog showing. */
export function cveHref(cveRecordId: string, tab?: string, options: { edit?: boolean } = {}): string {
  const params = new URLSearchParams({ id: cveRecordId });
  if (tab) params.set("tab", tab);
  if (options.edit) params.set("edit", "1");
  return `/vulnerabilities/view?${params.toString()}`;
}
