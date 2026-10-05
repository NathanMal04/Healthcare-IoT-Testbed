"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoadingState } from "@/app/components/ui";

/**
 * The CVE Database was renamed Vulnerabilities. This static page keeps old
 * /database bookmarks working (the site is a static export, so there are no
 * server redirects) by sending the browser to /vulnerabilities.
 */
export default function DatabaseRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/vulnerabilities");
  }, [router]);

  return (
    <div className="text-center">
      <LoadingState label="Opening Vulnerabilities…" />
      <Link href="/vulnerabilities" className="text-sm font-medium text-brand-600 hover:text-brand-700">
        Go to Vulnerabilities
      </Link>
    </div>
  );
}
