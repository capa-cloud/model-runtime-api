import { createHash } from "node:crypto";
import type { ProviderManifest } from "@model-runtime/protocol";

export interface CatalogSnapshot {
  schema_version: "1";
  observed_at: string;
  digest: string;
  providers: ProviderManifest[];
}

export interface CatalogDiff {
  added_models: string[];
  removed_models: string[];
  changed_models: string[];
}

export function createCatalogSnapshot(
  manifests: ProviderManifest[],
  observedAt = new Date().toISOString(),
): CatalogSnapshot {
  const providers = structuredClone(manifests).sort((a, b) => a.provider.localeCompare(b.provider));
  for (const provider of providers) provider.models.sort((a, b) => a.model.localeCompare(b.model));
  const digest = createHash("sha256").update(JSON.stringify(providers)).digest("hex");
  return { schema_version: "1", observed_at: observedAt, digest, providers };
}

export function diffCatalog(previous: CatalogSnapshot, current: CatalogSnapshot): CatalogDiff {
  const before = flatten(previous);
  const after = flatten(current);
  const added_models = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed_models = [...before.keys()].filter((key) => !after.has(key)).sort();
  const changed_models = [...after.keys()]
    .filter((key) => before.has(key) && before.get(key) !== after.get(key))
    .sort();
  return { added_models, removed_models, changed_models };
}

function flatten(snapshot: CatalogSnapshot): Map<string, string> {
  const result = new Map<string, string>();
  for (const provider of snapshot.providers) {
    for (const model of provider.models) {
      result.set(`${provider.provider}/${model.model}`, JSON.stringify(model));
    }
  }
  return result;
}
