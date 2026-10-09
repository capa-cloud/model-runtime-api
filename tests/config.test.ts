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

  it("loads model-specific text and media declarations", async () => {
    const path = await fixture({
      providers: [
        {
          type: "openai-responses",
          model: "model-alpha",
          api_key_env: "PROVIDER_A_API_KEY",
          capabilities: { input_modalities: ["text", "image"], tools: true },
        },
        {
          type: "fal-queue",
          model: "models/alpha",
          ability: "video-generation",
          api_key_env: "PROVIDER_MEDIA_API_KEY",
          input_modalities: ["text"],
          output_modalities: ["video"],
        },
      ],
    });
    const runtime = await runtimeFromConfig(path);
    expect((await runtime.manifests())[0]?.models[0]).toMatchObject({
      tools: true,
      input_modalities: ["text", "image"],
      structured_output: false,
    });
    expect((await runtime.manifests())[1]?.models[0]?.output_modalities).toEqual(["video"]);
    await runtime.close();
  });

  it("rejects unsafe or unsupported capability declarations", async () => {
    for (const capabilities of [
      null,
      [],
      { tools: "yes" },
      { structured_output: true },
      { input_modalities: ["audio"] },
      { input_modalities: [] },
      { input_modalities: null },
      { input_modalities: ["text", "text"] },
    ]) {
      await expect(
        runtimeFromConfig(
          await fixture({
            providers: [
              {
                type: "openai-responses",
                model: "model-alpha",
                api_key_env: "PROVIDER_A_API_KEY",
                capabilities,
              },
            ],
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      runtimeFromConfig(
        await fixture({
          providers: [
            {
              type: "fal-queue",
              model: "models/alpha",
              ability: "image-generation",
              api_key_env: "PROVIDER_MEDIA_API_KEY",
              input_modalities: ["audio"],
            },
          ],
        }),
      ),
    ).rejects.toThrow("modality declaration");
  });
});

async function fixture(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "model-runtime-config-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
