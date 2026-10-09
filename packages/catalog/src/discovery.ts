import { assertSafeBaseUrl, readJsonLimited } from "@model-runtime/core";
import { compare, digest, identifier, invalid, record, timestamp } from "./validation.js";

export type DiscoveryProvider = "openai" | "anthropic";
export interface DiscoveredModel {
  id: string;
  vendor_created_at?: string;
}
export interface DiscoverySnapshot {
  schema_version: "discovery/1";
  source: { provider: DiscoveryProvider; scope: string };
  observed_at: string;
  complete: true;
  digest: string;
  models: DiscoveredModel[];
}
export interface DiscoveryOptions {
  provider: DiscoveryProvider;
  scope: string;
  apiKey: string | (() => string | Promise<string>);
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPages?: number;
  observedAt?: string;
}

export function createDiscoverySnapshot(
  source: DiscoverySnapshot["source"],
  models: DiscoveredModel[],
  observedAt = new Date().toISOString(),
): DiscoverySnapshot {
  if (!source || !["openai", "anthropic"].includes(source.provider)) invalid();
  const normalizedSource = { provider: source.provider, scope: identifier(source.scope) };
  if (!Array.isArray(models) || models.length > 10000) invalid();
  const normalized = models
    .map((value) => {
      const model = record(value, ["id", "vendor_created_at"]);
      return {
        id: identifier(model.id),
        ...(model.vendor_created_at === undefined
          ? {}
          : { vendor_created_at: timestamp(model.vendor_created_at) }),
      };
    })
    .sort((a, b) => compare(a.id, b.id));
  if (new Set(normalized.map((model) => model.id)).size !== normalized.length) invalid();
  return {
    schema_version: "discovery/1",
    source: normalizedSource,
    observed_at: timestamp(observedAt),
    complete: true,
    digest: digest({ source: normalizedSource, models: normalized }),
    models: normalized,
  };
}

export function parseDiscoverySnapshot(value: unknown): DiscoverySnapshot {
  const snapshot = record(value, [
    "schema_version",
    "source",
    "observed_at",
    "complete",
    "digest",
    "models",
  ]);
  const source = record(snapshot.source, ["provider", "scope"]);
  if (snapshot.schema_version !== "discovery/1" || snapshot.complete !== true) invalid();
  const normalized = createDiscoverySnapshot(
    source as unknown as DiscoverySnapshot["source"],
    snapshot.models as DiscoveredModel[],
    snapshot.observed_at as string,
  );
  if (snapshot.digest !== normalized.digest) invalid();
  return normalized;
}

export function discoveryRadar(current: DiscoverySnapshot, previous?: DiscoverySnapshot) {
  const after = parseDiscoverySnapshot(current);
  if (!previous)
    return {
      status: "baseline" as const,
      source: after.source,
      observed_at: after.observed_at,
      model_count: after.models.length,
      added_models: [],
      no_longer_visible_models: [],
      metadata_changed_models: [],
    };
  const before = parseDiscoverySnapshot(previous);
  if (
    before.source.provider !== after.source.provider ||
    before.source.scope !== after.source.scope ||
    Date.parse(after.observed_at) < Date.parse(before.observed_at)
  )
    invalid();
  const oldModels = new Map(before.models.map((model) => [model.id, JSON.stringify(model)]));
  const newModels = new Map(after.models.map((model) => [model.id, JSON.stringify(model)]));
  return {
    status: "compared" as const,
    source: after.source,
    observed_at: after.observed_at,
    previous_observed_at: before.observed_at,
    model_count: after.models.length,
    added_models: [...newModels.keys()].filter((id) => !oldModels.has(id)).sort(),
    no_longer_visible_models: [...oldModels.keys()].filter((id) => !newModels.has(id)).sort(),
    metadata_changed_models: [...newModels.keys()]
      .filter((id) => oldModels.has(id) && oldModels.get(id) !== newModels.get(id))
      .sort(),
  };
}

export async function discoverModels(options: DiscoveryOptions): Promise<DiscoverySnapshot> {
  try {
    if (!["openai", "anthropic"].includes(options.provider)) invalid();
    identifier(options.scope);
    const timeoutMs = options.timeoutMs ?? 30000;
    const maxPages = options.maxPages ?? 100;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000 ||
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 100
    )
      invalid();
    const base = assertSafeBaseUrl(
      options.baseUrl ??
        (options.provider === "openai"
          ? "https://api.openai.com/v1/"
          : "https://api.anthropic.com/v1/"),
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    signal.throwIfAborted();
    const key = await credential(options.apiKey, signal);
    if (!key) invalid();
    const fetcher = options.fetch ?? globalThis.fetch;
    const models: DiscoveredModel[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < maxPages; page++) {
      const target = new URL("models", base.href.endsWith("/") ? base.href : `${base.href}/`);
      if (options.provider === "anthropic") {
        target.searchParams.set("limit", "1000");
        if (cursor) target.searchParams.set("after_id", cursor);
      }
      const response = await fetcher(target, {
        redirect: "error",
        signal,
        headers:
          options.provider === "openai"
            ? { authorization: `Bearer ${key}` }
            : { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Discovery request was rejected");
      }
      const body = record(await readJsonLimited(response, 1024 * 1024));
      if (
        !Array.isArray(body.data) ||
        body.data.length > 10000 ||
        (options.provider === "openai" && body.object !== "list")
      )
        invalid();
      for (const entry of body.data) {
        const value = record(entry);
        const id = identifier(value.id);
        if (seen.has(id) || models.length >= 10000) invalid();
        seen.add(id);
        let created: string | undefined;
        if (options.provider === "openai") {
          if (
            value.object !== "model" ||
            !Number.isSafeInteger(value.created) ||
            (value.created as number) < 0
          )
            invalid();
          created = timestamp(new Date((value.created as number) * 1000).toISOString());
        } else {
          if (value.type !== "model") invalid();
          created = timestamp(value.created_at);
        }
        models.push({ id, vendor_created_at: created });
      }
      if (options.provider === "openai")
        return createDiscoverySnapshot(
          { provider: options.provider, scope: options.scope },
          models,
          options.observedAt,
        );
      if (typeof body.has_more !== "boolean") invalid();
      if (!body.has_more)
        return createDiscoverySnapshot(
          { provider: options.provider, scope: options.scope },
          models,
          options.observedAt,
        );
      const next = identifier(body.last_id);
      if (!body.data.length || next !== models.at(-1)?.id || cursors.has(next)) invalid();
      cursor = next;
      cursors.add(next);
    }
    throw new Error("Discovery pagination limit exceeded");
  } catch {
    // Errors may originate in a credential callback, URL parser or remote response.
    throw new Error("Model discovery failed; no complete snapshot was produced");
  }
}

async function credential(value: DiscoveryOptions["apiKey"], signal: AbortSignal): Promise<string> {
  const pending = Promise.resolve(typeof value === "function" ? value() : value);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Credential resolution was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
