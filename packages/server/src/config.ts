import { readFile } from "node:fs/promises";
import {
  ModelRuntime,
  RuntimeError,
  InMemoryEventStore,
  FileEventStore,
  assertSafeBaseUrl,
  type EventStoreLimits,
  textCapabilities,
  declaredModalities,
  type TextProviderCapabilities,
} from "@model-runtime/core";
import type { Modality } from "@model-runtime/protocol";
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
      capabilities?: TextProviderCapabilities;
    }
  | {
      type: "anthropic-messages";
      id?: string;
      model: string;
      abilities?: string[];
      api_key_env: string;
      base_url?: string;
      capabilities?: TextProviderCapabilities;
    }
  | {
      type: "fal-queue";
      id?: string;
      model: string;
      ability: string;
      api_key_env: string;
      base_url?: string;
      input_modalities?: Modality[];
      output_modalities?: Modality[];
    };

interface RuntimeConfig {
  providers: ProviderConfig[];
  max_active_executions?: number;
  event_store?: {
    type: "memory" | "file";
    directory?: string;
    encryption_key_env?: string;
    max_executions?: number;
    max_bytes?: number;
    max_execution_bytes?: number;
    max_events?: number;
    retention_ms?: number;
    max_disk_bytes?: number;
  };
}

export async function runtimeFromConfig(path?: string): Promise<ModelRuntime> {
  if (!path) {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider(), { maxConcurrency: 4, maxQueueDepth: 8 });
    return runtime;
  }
  const config = validateConfig(JSON.parse(await readFile(path, "utf8")));
  const limits: EventStoreLimits = {
    maxExecutions: config.event_store?.max_executions,
    maxBytes: config.event_store?.max_bytes,
    maxExecutionBytes: config.event_store?.max_execution_bytes,
    maxEvents: config.event_store?.max_events,
    retentionMs: config.event_store?.retention_ms,
  };
  let eventStore: InMemoryEventStore;
  if (config.event_store?.type === "file") {
    const encoded = secretResolver(config.event_store.encryption_key_env!)();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error("Invalid store key encoding");
    eventStore = await FileEventStore.open({
      ...limits,
      directory: config.event_store.directory!,
      encryptionKey: Buffer.from(encoded, "base64"),
      maxDiskBytes: config.event_store.max_disk_bytes,
    });
  } else eventStore = new InMemoryEventStore(limits);
  const runtime = new ModelRuntime({
    eventStore,
    maxActiveExecutions: config.max_active_executions,
  });
  try {
    for (const provider of config.providers) {
      if (provider.type === "mock") {
        runtime.register(
          new MockProvider({
            id: provider.id,
            model: provider.model,
            abilities: provider.abilities,
          }),
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
            capabilities: provider.capabilities,
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
            capabilities: provider.capabilities,
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
            inputModalities: provider.input_modalities,
            outputModalities: provider.output_modalities,
          }),
        );
      } else {
        const exhaustive: never = provider;
        throw new Error(`Unsupported provider configuration: ${String(exhaustive)}`);
      }
    }
    return runtime;
  } catch (error) {
    await runtime.close();
    throw error;
  }
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
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).some(
      (key) => !["providers", "max_active_executions", "event_store"].includes(key),
    )
  )
    throw new Error("Unsupported runtime config field");
  if (root.max_active_executions !== undefined) positiveInteger(root.max_active_executions);
  if (root.event_store !== undefined) {
    if (
      !root.event_store ||
      typeof root.event_store !== "object" ||
      Array.isArray(root.event_store)
    )
      throw new Error("Invalid event store config");
    const store = root.event_store as Record<string, unknown>;
    if (
      !["memory", "file"].includes(String(store.type)) ||
      Object.keys(store).some(
        (key) =>
          ![
            "type",
            "directory",
            "encryption_key_env",
            "max_executions",
            "max_bytes",
            "max_execution_bytes",
            "max_events",
            "retention_ms",
            "max_disk_bytes",
          ].includes(key),
      )
    )
      throw new Error("Invalid event store fields");
    if (
      store.type === "file" &&
      (typeof store.directory !== "string" ||
        !store.directory ||
        typeof store.encryption_key_env !== "string")
    )
      throw new Error("File event store requires a directory and key environment name");
    if (
      store.type === "memory" &&
      ["directory", "encryption_key_env", "max_disk_bytes"].some((key) => store[key] !== undefined)
    )
      throw new Error("Memory store contains file-only settings");
    for (const key of [
      "max_executions",
      "max_bytes",
      "max_execution_bytes",
      "max_events",
      "retention_ms",
      "max_disk_bytes",
    ])
      if (store[key] !== undefined) positiveInteger(store[key]);
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
          ? new Set([
              "type",
              "id",
              "model",
              "ability",
              "api_key_env",
              "base_url",
              "input_modalities",
              "output_modalities",
            ])
          : new Set([
              "type",
              "id",
              "model",
              "abilities",
              "api_key_env",
              "base_url",
              "capabilities",
            ]);
    if (Object.keys(record).some((key) => !allowedFields.has(key))) {
      throw new Error("Provider config contains an unsupported or unsafe field");
    }
    if (record.type === "openai-responses" || record.type === "anthropic-messages") {
      textCapabilities(
        record.capabilities as TextProviderCapabilities | undefined,
        record.type === "openai-responses"
          ? ["text", "json", "image", "file"]
          : ["text", "json", "image"],
      );
    } else if (record.type === "fal-queue") {
      declaredModalities(
        record.input_modalities as Modality[] | undefined,
        ["text", "json"],
        ["text", "json", "image"],
      );
      declaredModalities(
        record.output_modalities as Modality[] | undefined,
        ["json"],
        ["text", "json", "image", "audio", "video", "file"],
      );
    }
    for (const key of ["id", "model", "ability"]) {
      if (
        record[key] !== undefined &&
        (typeof record[key] !== "string" ||
          !(record[key] as string).length ||
          (record[key] as string).length > 256)
      )
        throw new Error("Provider identifiers must be bounded strings");
    }
    if (
      record.abilities !== undefined &&
      (!Array.isArray(record.abilities) ||
        record.abilities.length < 1 ||
        record.abilities.some((value) => typeof value !== "string" || !value || value.length > 256))
    )
      throw new Error("Invalid provider abilities");
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
      assertSafeBaseUrl(record.base_url);
    }
  }
  return { ...root, providers: providers as ProviderConfig[] } as unknown as RuntimeConfig;
}

function positiveInteger(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Runtime limits must be positive integers");
}
