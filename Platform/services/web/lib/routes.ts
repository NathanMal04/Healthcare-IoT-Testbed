// Links to pages that take their subject from the query string (the site is
// a static export, so there are no dynamic route segments).

export function deviceHref(deviceId: string, tab?: string): string {
  const params = new URLSearchParams({ id: deviceId });
  if (tab) params.set("tab", tab);
  return `/devices/view?${params.toString()}`;
}

export function cveHref(cveRecordId: string, tab?: string): string {
  const params = new URLSearchParams({ id: cveRecordId });
  if (tab) params.set("tab", tab);
  return `/vulnerabilities/view?${params.toString()}`;
}
