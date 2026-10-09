import { parseCatalogSnapshot, type CatalogSnapshot } from "@model-runtime/catalog";
import { canonicalJson, evaluationDigest, hash, invalid, object } from "./validation.js";

export interface EvaluationCatalog {
  schema_version: "evaluation-catalog/1";
  catalog: CatalogSnapshot;
  configurations: { provider: string; model: string; configuration_digest: string }[];
  digest: string;
}

export function createEvaluationCatalog(
  catalogInput: CatalogSnapshot,
  configurations: EvaluationCatalog["configurations"],
): EvaluationCatalog {
  const catalog = parseCatalogSnapshot(catalogInput);
  const models = new Set(
    catalog.providers.flatMap((provider) =>
      provider.models.map((model) => JSON.stringify([provider.provider, model.model])),
    ),
  );
  if (
    !Array.isArray(configurations) ||
    configurations.length !== models.size ||
    configurations.length > 64
  )
    invalid();
  const seen = new Set<string>();
  const normalized = configurations
    .map((value) => {
      const config = object(value, ["provider", "model", "configuration_digest"]);
      const key = JSON.stringify([config.provider, config.model]);
      if (!models.has(key) || seen.has(key)) invalid();
      seen.add(key);
      return {
        provider: config.provider as string,
        model: config.model as string,
        configuration_digest: hash(config.configuration_digest),
      };
    })
    .sort((a, b) =>
      canonicalJson([a.provider, a.model]) < canonicalJson([b.provider, b.model]) ? -1 : 1,
    );
  const body = {
    schema_version: "evaluation-catalog/1" as const,
    catalog,
    configurations: normalized,
  };
  return { ...body, digest: evaluationDigest(body) };
}

export function parseEvaluationCatalog(value: unknown): EvaluationCatalog {
  try {
    const profile = object(value, ["schema_version", "catalog", "configurations", "digest"]);
    if (
      profile.schema_version !== "evaluation-catalog/1" ||
      Buffer.byteLength(canonicalJson(value)) > 4 * 1024 * 1024
    )
      invalid();
    const normalized = createEvaluationCatalog(
      profile.catalog as CatalogSnapshot,
      profile.configurations as EvaluationCatalog["configurations"],
    );
    if (profile.digest !== normalized.digest) invalid();
    return normalized;
  } catch {
    invalid();
  }
}
