import { readFile } from "node:fs/promises";
import { ModelRuntime, RuntimeError } from "@model-runtime/core";
import { AnthropicMessagesProvider } from "@model-runtime/provider-anthropic";
import { FalQueueProvider } from "@model-runtime/provider-fal";
import { MockProvider } from "@model-runtime/provider-mock";
import { OpenAiResponsesProvider } from "@model-runtime/provider-openai";

type ProviderConfig =
  | { type: "mock"; id?: string; model?: string; abilities?: string[] }
  | {
      type: "openai-responses";
      id?: string;
      model: string;
      abilities?: string[];
      api_key_env: string;
      base_url?: string;
    }
  | {
      type: "anthropic-messages";
      id?: string;
      model: string;
      abilities?: string[];
      api_key_env: string;
      base_url?: string;
    }
  | {
      type: "fal-queue";
      id?: string;
      model: string;
      ability: string;
      api_key_env: string;
      base_url?: string;
    };

interface RuntimeConfig {
  providers: ProviderConfig[];
}

export async function runtimeFromConfig(path?: string): Promise<ModelRuntime> {
  const runtime = new ModelRuntime();
  if (!path) {
    runtime.register(new MockProvider(), { maxConcurrency: 4, maxQueueDepth: 8 });
    return runtime;
  }
  const config = validateConfig(JSON.parse(await readFile(path, "utf8")));
  for (const provider of config.providers) {
    if (provider.type === "mock") {
      runtime.register(
        new MockProvider({ id: provider.id, model: provider.model, abilities: provider.abilities }),
      );
      continue;
    }
    const apiKey = secretResolver(provider.api_key_env);
    if (provider.type === "openai-responses") {
      runtime.register(
        new OpenAiResponsesProvider({
          id: provider.id,
          model: provider.model,
          abilities: provider.abilities,
          apiKey,
          baseUrl: provider.base_url,
        }),
      );
    } else if (provider.type === "anthropic-messages") {
      runtime.register(
        new AnthropicMessagesProvider({
          id: provider.id,
          model: provider.model,
          abilities: provider.abilities,
          apiKey,
          baseUrl: provider.base_url,
        }),
      );
    } else if (provider.type === "fal-queue") {
      runtime.register(
        new FalQueueProvider({
          id: provider.id,
          model: provider.model,
          ability: provider.ability,
          apiKey,
          baseUrl: provider.base_url,
        }),
      );
    } else {
      const exhaustive: never = provider;
      throw new Error(`Unsupported provider configuration: ${String(exhaustive)}`);
    }
  }
  return runtime;
}

function secretResolver(name: string): () => string {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(name)) {
    throw new RuntimeError("invalid_request", "api_key_env must be an uppercase environment name");
  }
  return () => {
    const value = process.env[name];
    if (!value) {
      throw new RuntimeError("provider_unavailable", "Required provider credential is unavailable");
    }
    return value;
  };
}

function validateConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime config must be an object");
  }
  const providers = (value as { providers?: unknown }).providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("Runtime config requires at least one provider");
  }
  const allowed = new Set(["mock", "openai-responses", "anthropic-messages", "fal-queue"]);
  for (const provider of providers) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error("Provider config must be an object");
    }
    const record = provider as Record<string, unknown>;
    if (typeof record.type !== "string" || !allowed.has(record.type)) {
      throw new Error("Provider config type is unsupported");
    }
    const allowedFields =
      record.type === "mock"
        ? new Set(["type", "id", "model", "abilities"])
        : record.type === "fal-queue"
          ? new Set(["type", "id", "model", "ability", "api_key_env", "base_url"])
          : new Set(["type", "id", "model", "abilities", "api_key_env", "base_url"]);
    if (Object.keys(record).some((key) => !allowedFields.has(key))) {
      throw new Error("Provider config contains an unsupported or unsafe field");
    }
    if (record.type !== "mock") {
      if (typeof record.model !== "string" || record.model.length === 0) {
        throw new Error("Provider config requires a non-empty model");
      }
      if (typeof record.api_key_env !== "string") {
        throw new Error("Provider config requires api_key_env");
      }
    }
    if (record.type === "fal-queue" && (typeof record.ability !== "string" || !record.ability)) {
      throw new Error("fal-queue provider config requires ability");
    }
    if (record.base_url !== undefined) {
      if (typeof record.base_url !== "string") throw new Error("base_url must be a string");
      const base = new URL(record.base_url);
      const loopback = ["127.0.0.1", "localhost", "::1"].includes(base.hostname);
      if (base.protocol !== "https:" && !(loopback && base.protocol === "http:")) {
        throw new Error("base_url must be HTTPS or loopback HTTP");
      }
    }
  }
  return { providers: providers as ProviderConfig[] };
}
