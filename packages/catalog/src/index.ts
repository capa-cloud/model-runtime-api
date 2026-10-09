import type { ModelCapability, ProviderManifest, Modality } from "@model-runtime/protocol";
import {
  boolean,
  compare,
  digest,
  identifier,
  invalid,
  record,
  strings,
  timestamp,
} from "./validation.js";

export * from "./discovery.js";
export * from "./poll.js";

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
  const providers = normalizeManifests(manifests);
  return {
    schema_version: "1",
    observed_at: timestamp(observedAt),
    digest: digest(providers),
    providers,
  };
}

export function parseCatalogSnapshot(value: unknown): CatalogSnapshot {
  const snapshot = record(value, ["schema_version", "observed_at", "digest", "providers"]);
  if (snapshot.schema_version !== "1" || snapshot.digest !== digest(snapshot.providers)) invalid();
  timestamp(snapshot.observed_at);
  normalizeManifests(snapshot.providers);
  // Preserve the digest of older snapshots; comparison canonicalizes set ordering separately.
  return structuredClone(value) as CatalogSnapshot;
}

export function diffCatalog(previous: CatalogSnapshot, current: CatalogSnapshot): CatalogDiff {
  const before = flatten(parseCatalogSnapshot(previous));
  const after = flatten(parseCatalogSnapshot(current));
  const added_models = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed_models = [...before.keys()].filter((key) => !after.has(key)).sort();
  const changed_models = [...after.keys()]
    .filter((key) => before.has(key) && before.get(key) !== after.get(key))
    .sort();
  return { added_models, removed_models, changed_models };
}

function flatten(snapshot: CatalogSnapshot): Map<string, string> {
  const result = new Map<string, string>();
  for (const provider of normalizeManifests(snapshot.providers)) {
    for (const model of provider.models) {
      result.set(`${provider.provider}/${model.model}`, JSON.stringify(model));
    }
  }
  return result;
}

function normalizeManifests(value: unknown): ProviderManifest[] {
  if (!Array.isArray(value) || value.length > 128) invalid();
  const providers = value
    .map((entry): ProviderManifest => {
      const provider = record(entry, ["provider", "protocol_version", "models", "limits"]);
      const id = identifier(provider.provider);
      if (
        id.includes("/") ||
        provider.protocol_version !== "0.1.0" ||
        !Array.isArray(provider.models) ||
        provider.models.length > 10000
      )
        invalid();
      const models = provider.models.map(normalizeModel).sort((a, b) => compare(a.model, b.model));
      if (new Set(models.map((model) => model.model)).size !== models.length) invalid();
      let limits: ProviderManifest["limits"];
      if (provider.limits !== undefined) {
        const source = record(provider.limits, ["max_concurrency", "max_queue_depth"]);
        limits = {};
        for (const key of ["max_concurrency", "max_queue_depth"] as const) {
          const limit = source[key];
          if (limit !== undefined) {
            if (
              !Number.isSafeInteger(limit) ||
              (limit as number) < (key === "max_concurrency" ? 1 : 0)
            )
              invalid();
            limits[key] = limit as number;
          }
        }
      }
      return { provider: id, protocol_version: "0.1.0", models, ...(limits ? { limits } : {}) };
    })
    .sort((a, b) => compare(a.provider, b.provider));
  if (
    new Set(providers.map((provider) => provider.provider)).size !== providers.length ||
    providers.reduce((total, provider) => total + provider.models.length, 0) > 10000
  )
    invalid();
  return providers;
}

function normalizeModel(value: unknown): ModelCapability {
  const model = record(value, [
    "model",
    "abilities",
    "input_modalities",
    "output_modalities",
    "stream",
    "tools",
    "structured_output",
    "async",
    "cancel",
  ]);
  const modalities = ["text", "json", "image", "audio", "video", "file"];
  return {
    model: identifier(model.model),
    abilities: strings(model.abilities),
    input_modalities: strings(model.input_modalities, modalities) as Modality[],
    output_modalities: strings(model.output_modalities, modalities) as Modality[],
    stream: boolean(model.stream),
    tools: boolean(model.tools),
    structured_output: boolean(model.structured_output),
    async: boolean(model.async),
    cancel: boolean(model.cancel),
  };
}
