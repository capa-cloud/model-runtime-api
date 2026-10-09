import {
  assertSafeBaseUrl,
  assertTextCapabilities,
  textCapabilities,
  type TextProviderCapabilities,
  type ModelProvider,
  type ProviderExecutionContext,
  providerHttpError,
  readSse,
  RuntimeError,
} from "@model-runtime/core";
import type {
  InputPart,
  ProviderEvent,
  ProviderManifest,
  UsageFact,
} from "@model-runtime/protocol";
import { protocolVersion } from "@model-runtime/protocol";

export interface OpenAiResponsesProviderOptions {
  id?: string;
  apiKey: string | (() => string | Promise<string>);
  model: string;
  abilities?: string[];
  baseUrl?: string;
  fetch?: typeof fetch;
  capabilities?: TextProviderCapabilities;
}

export class OpenAiResponsesProvider implements ModelProvider {
  readonly id: string;
  readonly #apiKey: OpenAiResponsesProviderOptions["apiKey"];
  readonly #model: string;
  readonly #abilities: string[];
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #capabilities: ReturnType<typeof textCapabilities>;

  constructor(options: OpenAiResponsesProviderOptions) {
    this.id = options.id ?? "openai";
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#abilities = [...(options.abilities ?? ["text-generation"])];
    this.#capabilities = textCapabilities(options.capabilities, ["text", "json", "image", "file"]);
    this.#baseUrl = assertSafeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async manifest(): Promise<ProviderManifest> {
    return {
      provider: this.id,
      protocol_version: protocolVersion,
      models: [
        {
          model: this.#model,
          abilities: [...this.#abilities],
          input_modalities: [...this.#capabilities.input_modalities],
          output_modalities: ["text"],
          stream: true,
          tools: this.#capabilities.tools,
          structured_output: false,
          async: false,
          cancel: true,
        },
      ],
    };
  }

  async *execute(context: ProviderExecutionContext): AsyncIterable<ProviderEvent> {
    const extension = asRecord(context.request.extensions?.openai);
    const requestExtension = asRecord(extension.request);
    assertTextCapabilities(context.request, this.#capabilities, requestExtension);
    const response = await this.#fetch(new URL("responses", withTrailingSlash(this.#baseUrl)), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${await resolveSecret(this.#apiKey)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...requestExtension,
        model: this.#model,
        input: [{ role: "user", content: context.request.input.map(toOpenAiPart) }],
        stream: true,
        store: false,
      }),
      signal: context.signal,
    });
    if (!response.ok) throw await providerHttpError(response);

    let completed = false;
    const toolCalls = new Map<string, string>();
    for await (const frame of readSse(response)) {
      if (frame.data === "[DONE]") continue;
      const payload = parseJson(frame.data);
      const type = stringValue(payload.type ?? frame.event);
      if (type === "response.output_text.delta") {
        yield {
          type: "output.delta",
          output_index: numberValue(payload.output_index),
          delta: stringValue(payload.delta),
        };
      } else if (type === "response.output_item.added") {
        const item = asRecord(payload.item);
        if (item.type === "function_call") {
          const itemId = stringValue(item.id);
          const callId = stringValue(item.call_id);
          toolCalls.set(itemId, callId);
          yield {
            type: "tool.call.started",
            call_id: callId,
            name: stringValue(item.name),
          };
        }
      } else if (type === "response.function_call_arguments.delta") {
        const itemId = stringValue(payload.item_id);
        yield {
          type: "tool.call.arguments.delta",
          call_id: toolCalls.get(itemId) ?? itemId,
          delta: stringValue(payload.delta),
        };
      } else if (type === "response.completed") {
        const usage = openAiUsage(asRecord(asRecord(payload.response).usage));
        if (usage.length) yield { type: "usage.reported", facts: usage };
        completed = true;
        yield { type: "execution.completed" };
      } else if (type === "response.failed" || type === "error") {
        throw new RuntimeError("provider_unavailable", "OpenAI response failed", {
          retryable: false,
        });
      }
    }
    if (!completed)
      throw new RuntimeError(
        "provider_protocol_error",
        "OpenAI stream ended without response.completed",
      );
  }
}

function toOpenAiPart(part: InputPart): Record<string, unknown> {
  if (part.type === "text") return { type: "input_text", text: part.text };
  if (part.type === "json") return { type: "input_text", text: JSON.stringify(part.value) };
  if (part.type === "image") return { type: "input_image", image_url: part.uri };
  if (part.type === "file") return { type: "input_file", file_url: part.uri };
  throw new RuntimeError(
    "capability_unavailable",
    `OpenAI adapter does not support ${part.type} input`,
  );
}

function openAiUsage(usage: Record<string, unknown>): UsageFact[] {
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  return compactFacts([
    fact("input_token", usage.input_tokens),
    fact("output_token", usage.output_tokens),
    fact("cache_write_token", inputDetails.cache_write_tokens),
    fact("cache_read_token", inputDetails.cached_tokens),
    fact("reasoning_token", outputDetails.reasoning_tokens),
  ]);
}

function fact(unit: string, value: unknown): UsageFact | undefined {
  return typeof value === "number"
    ? { unit, quantity: value, source: "provider", complete: true }
    : undefined;
}

function compactFacts(values: (UsageFact | undefined)[]): UsageFact[] {
  return values.filter((value): value is UsageFact => value !== undefined);
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value));
  } catch (error) {
    throw new RuntimeError("provider_protocol_error", "OpenAI returned invalid SSE JSON", {
      cause: error,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function withTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}

async function resolveSecret(value: OpenAiResponsesProviderOptions["apiKey"]): Promise<string> {
  const secret = typeof value === "function" ? await value() : value;
  if (!secret) throw new RuntimeError("provider_unavailable", "OpenAI credential is unavailable");
  return secret;
}
