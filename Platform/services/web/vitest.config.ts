import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for pure logic (lib/**/*.test.ts, Node) and component tests
// (app/**/*.test.tsx, which opt into jsdom with a `@vitest-environment jsdom`
// comment and use @testing-library/react): `npm test`.
export default defineConfig({
  resolve: {
    // The same "@/..." imports as tsconfig.json's paths.
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }],
  },
  // tsconfig.json keeps JSX for Next.js ("preserve"); tests compile it here.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["lib/**/*.test.ts", "app/**/*.test.tsx"],
    environment: "node",
  },
});
