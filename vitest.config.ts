import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@model-runtime/transport": fileURLToPath(
        new URL("./packages/transport/src/index.ts", import.meta.url),
      ),
      "@model-runtime/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
      "@model-runtime/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@model-runtime/provider-mock": fileURLToPath(
        new URL("./packages/provider-mock/src/index.ts", import.meta.url),
      ),
      "@model-runtime/provider-openai": fileURLToPath(
        new URL("./packages/provider-openai/src/index.ts", import.meta.url),
      ),
      "@model-runtime/provider-anthropic": fileURLToPath(
        new URL("./packages/provider-anthropic/src/index.ts", import.meta.url),
      ),
      "@model-runtime/provider-fal": fileURLToPath(
        new URL("./packages/provider-fal/src/index.ts", import.meta.url),
      ),
      "@model-runtime/conformance": fileURLToPath(
        new URL("./packages/conformance/src/index.ts", import.meta.url),
      ),
      "@model-runtime/catalog": fileURLToPath(
        new URL("./packages/catalog/src/index.ts", import.meta.url),
      ),
      "@model-runtime/server": fileURLToPath(
        new URL("./packages/server/src/index.ts", import.meta.url),
      ),
      "@model-runtime/sdk-typescript": fileURLToPath(
        new URL("./packages/sdk-typescript/src/index.ts", import.meta.url),
      ),
      "@model-runtime/otel": fileURLToPath(
        new URL("./packages/otel/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    maxWorkers: 2,
    include: ["tests/**/*.test.ts"],
    testTimeout: 5_000,
  },
});
