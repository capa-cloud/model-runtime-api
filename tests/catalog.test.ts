import { describe, expect, it } from "vitest";
import { createCatalogSnapshot, diffCatalog } from "@model-runtime/catalog";
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
});

function manifest(provider: string, models: ProviderManifest["models"]): ProviderManifest {
  return { provider, protocol_version: "0.1.0", models };
}
