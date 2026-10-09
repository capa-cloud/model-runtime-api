import { describe, expect, it } from "vitest";
import { createCatalogSnapshot, diffCatalog, parseCatalogSnapshot } from "@model-runtime/catalog";
import { createHash } from "node:crypto";
import type { ProviderManifest } from "@model-runtime/protocol";

const capability = {
  abilities: ["text-generation"],
  input_modalities: ["text" as const],
  output_modalities: ["text" as const],
  stream: true,
  tools: false,
  structured_output: false,
  async: false,
  cancel: true,
};

describe("versioned capability catalog", () => {
  it("detects added, removed and changed models deterministically", () => {
    const previous = createCatalogSnapshot([
      manifest("provider-a", [
        { model: "model-one", ...capability },
        { model: "model-old", ...capability },
      ]),
    ]);
    const current = createCatalogSnapshot([
      manifest("provider-a", [
        { model: "model-one", ...capability, tools: true },
        { model: "model-new", ...capability },
      ]),
    ]);
    expect(diffCatalog(previous, current)).toEqual({
      added_models: ["provider-a/model-new"],
      removed_models: ["provider-a/model-old"],
      changed_models: ["provider-a/model-one"],
    });
  });

  it("canonicalizes object/set ordering without mutating inputs", () => {
    const model = {
      model: "model-one",
      ...capability,
      input_modalities: ["text" as const, "json" as const],
      abilities: ["text-generation", "code-generation"],
    };
    const before = createCatalogSnapshot([manifest("provider-a", [model])]);
    const after = createCatalogSnapshot([
      manifest("provider-a", [
        {
          ...model,
          abilities: [...model.abilities].reverse(),
          input_modalities: [...model.input_modalities].reverse(),
        },
      ]),
    ]);
    expect(before.digest).toBe(after.digest);
    expect(diffCatalog(before, after).changed_models).toEqual([]);
    expect(model.input_modalities).toEqual(["text", "json"]);
  });

  it("accepts valid original digests while canonicalizing legacy snapshots for diff", () => {
    const providers = [manifest("provider-a", [{ ...capability, model: "model-one" }])];
    const legacy = {
      schema_version: "1" as const,
      observed_at: "2026-10-09T00:00:00Z",
      digest: createHash("sha256").update(JSON.stringify(providers)).digest("hex"),
      providers,
    };
    expect(parseCatalogSnapshot(legacy).digest).toBe(legacy.digest);
    expect(diffCatalog(legacy, createCatalogSnapshot(providers)).changed_models).toEqual([]);
  });

  it("rejects corrupted, ambiguous and unsafe catalog metadata", () => {
    const snapshot = createCatalogSnapshot([
      manifest("provider-a", [{ model: "model-one", ...capability }]),
    ]);
    expect(() => parseCatalogSnapshot({ ...snapshot, digest: "invalid" })).toThrow();
    expect(() => createCatalogSnapshot([snapshot.providers[0]!, snapshot.providers[0]!])).toThrow();
    expect(() =>
      createCatalogSnapshot([
        manifest("provider-a", [
          snapshot.providers[0]!.models[0]!,
          snapshot.providers[0]!.models[0]!,
        ]),
      ]),
    ).toThrow();
    expect(() => createCatalogSnapshot([manifest("provider-a/ambiguous", [])])).toThrow();
    expect(() =>
      createCatalogSnapshot([
        { ...snapshot.providers[0]!, private_endpoint: "synthetic" } as ProviderManifest,
      ]),
    ).toThrow();
  });
});

function manifest(provider: string, models: ProviderManifest["models"]): ProviderManifest {
  return { provider, protocol_version: "0.1.0", models };
}
