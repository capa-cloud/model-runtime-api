import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeFromConfig } from "@model-runtime/server";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("runtime provider configuration", () => {
  it("loads a public mock config", async () => {
    const path = await fixture({ providers: [{ type: "mock", id: "provider-a" }] });
    expect(await runtimeFromConfig(path)).toMatchObject({});
  });

  it("rejects inline credential-like fields", async () => {
    const path = await fixture({
      providers: [{ type: "openai-responses", model: "model-public", api_key: "not-allowed" }],
    });
    await expect(runtimeFromConfig(path)).rejects.toThrow("unsupported or unsafe field");
  });

  it("rejects a non-HTTPS remote provider endpoint", async () => {
    const path = await fixture({
      providers: [
        {
          type: "openai-responses",
          model: "model-public",
          api_key_env: "PROVIDER_A_API_KEY",
          base_url: "http://example.test",
        },
      ],
    });
    await expect(runtimeFromConfig(path)).rejects.toThrow("HTTPS or loopback HTTP");
  });

  it("rejects inline store keys, unknown top-level fields and invalid resource settings", async () => {
    for (const value of [
      { providers: [{ type: "mock" }], event_store: { type: "file", encryption_key: "fixture" } },
      { providers: [{ type: "mock" }], unsafe_field: "fixture" },
      { providers: [{ type: "mock" }], max_active_executions: 0 },
      { providers: [{ type: "mock" }], event_store: { type: "memory", directory: "fixture" } },
    ])
      await expect(runtimeFromConfig(await fixture(value))).rejects.toThrow();
  });
});

async function fixture(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "model-runtime-config-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
