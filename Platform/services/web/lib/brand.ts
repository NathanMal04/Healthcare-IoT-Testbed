/**
 * The product name and the site's hostname, fixed at build time. deploy-web.yml
 * sets them from Terraform's brand_name and site_host outputs; unset (local
 * development, tests) they fall back to the original deployment's.
 *
 * Next.js inlines NEXT_PUBLIC_* only where they are read literally, so they are
 * read here, once.
 */
export const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || "Vzoniq";

/** Hostname shown in the landing page's browser-frame previews. */
export const SITE_HOST = process.env.NEXT_PUBLIC_SITE_HOST?.trim() || "vzoniq.com";
