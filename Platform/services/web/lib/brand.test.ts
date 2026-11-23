import { afterEach, describe, expect, it, vi } from "vitest";

async function loadBrand() {
  vi.resetModules();
  return import("./brand");
}

describe("brand", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the original deployment", async () => {
    vi.stubEnv("NEXT_PUBLIC_BRAND_NAME", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_HOST", "");
    const brand = await loadBrand();
    expect(brand.BRAND_NAME).toBe("Vzoniq");
    expect(brand.SITE_HOST).toBe("vzoniq.com");
  });

  it("uses the build's brand name and host", async () => {
    vi.stubEnv("NEXT_PUBLIC_BRAND_NAME", " Acme Testbed ");
    vi.stubEnv("NEXT_PUBLIC_SITE_HOST", "testbed.example.org");
    const brand = await loadBrand();
    expect(brand.BRAND_NAME).toBe("Acme Testbed");
    expect(brand.SITE_HOST).toBe("testbed.example.org");
  });
});
