import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for pure logic only (no DOM): `npm test`.
export default defineConfig({
  resolve: {
    // The same "@/..." imports as tsconfig.json's paths.
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }],
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
