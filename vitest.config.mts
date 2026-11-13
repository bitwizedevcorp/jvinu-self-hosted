import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./tests/empty.ts", import.meta.url)),
      // The "@/…" imports route handlers use (tsconfig paths).
      "@/": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The suites share real services (emulators, Garage); one file at a time keeps them apart.
    fileParallelism: false,
  },
});
