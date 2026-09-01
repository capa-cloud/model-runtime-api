import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@model-runtime/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
      "@model-runtime/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@model-runtime/provider-mock": fileURLToPath(
        new URL("./packages/provider-mock/src/index.ts", import.meta.url),
      ),
      "@model-runtime/conformance": fileURLToPath(
        new URL("./packages/conformance/src/index.ts", import.meta.url),
      ),
      "@model-runtime/server": fileURLToPath(
        new URL("./packages/server/src/index.ts", import.meta.url),
      ),
      "@model-runtime/sdk-typescript": fileURLToPath(
        new URL("./packages/sdk-typescript/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 5_000,
  },
});
