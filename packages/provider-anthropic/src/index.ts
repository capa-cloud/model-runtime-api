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

export interface AnthropicMessagesProviderOptions {
  id?: string;
  apiKey: string | (() => string | Promise<string>);
  model: string;
  maxTokens?: number;
  abilities?: string[];
  baseUrl?: string;
  fetch?: typeof fetch;
  capabilities?: TextProviderCapabilities;
}

export class AnthropicMessagesProvider implements ModelProvider {
  readonly id: string;
  readonly #options: AnthropicMessagesProviderOptions;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #capabilities: ReturnType<typeof textCapabilities>;

  constructor(options: AnthropicMessagesProviderOptions) {
    this.id = options.id ?? "anthropic";
    this.#options = { ...options, abilities: [...(options.abilities ?? ["text-generation"])] };
    this.#capabilities = textCapabilities(options.capabilities, ["text", "json", "image"]);
    this.#baseUrl = assertSafeBaseUrl(options.baseUrl ?? "https://api.anthropic.com");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async manifest(): Promise<ProviderManifest> {
    return {
      provider: this.id,
      protocol_version: protocolVersion,
      models: [
        {
          model: this.#options.model,
          abilities: [...this.#options.abilities!],
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
    const extension = asRecord(context.request.extensions?.anthropic);
    const requestExtension = asRecord(extension.request);
    assertTextCapabilities(context.request, this.#capabilities, requestExtension);
    const response = await this.#fetch(new URL("v1/messages", withTrailingSlash(this.#baseUrl)), {
      method: "POST",
      redirect: "error",
      headers: {
        "x-api-key": await resolveSecret(this.#options.apiKey),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...requestExtension,
        model: this.#options.model,
        max_tokens: this.#options.maxTokens ?? 1024,
        messages: [{ role: "user", content: context.request.input.map(toAnthropicPart) }],
        stream: true,
      }),
      signal: context.signal,
    });
    if (!response.ok) throw await providerHttpError(response);

    const toolBlocks = new Map<number, { id: string; name: string }>();
    const usage: Record<string, number> = {};
    let completed = false;
    for await (const frame of readSse(response)) {
      const payload = parseJson(frame.data);
      const type = stringValue(payload.type ?? frame.event);
      if (type === "message_start") mergeUsage(usage, asRecord(asRecord(payload.message).usage));
      else if (type === "content_block_start") {
        const block = asRecord(payload.content_block);
        if (block.type === "tool_use") {
          const index = numberValue(payload.index);
          const tool = { id: stringValue(block.id), name: stringValue(block.name) };
          toolBlocks.set(index, tool);
          yield { type: "tool.call.started", call_id: tool.id, name: tool.name };
        }
      } else if (type === "content_block_delta") {
        const delta = asRecord(payload.delta);
        if (delta.type === "text_delta") {
          yield {
            type: "output.delta",
            output_index: numberValue(payload.index),
            delta: stringValue(delta.text),
          };
        } else if (delta.type === "input_json_delta") {
          const tool = toolBlocks.get(numberValue(payload.index));
          if (!tool)
            throw new RuntimeError(
              "provider_protocol_error",
              "Anthropic tool delta has no matching tool block",
            );
          yield {
            type: "tool.call.arguments.delta",
            call_id: tool.id,
            delta: stringValue(delta.partial_json),
          };
        }
      } else if (type === "message_delta") mergeUsage(usage, asRecord(payload.usage));
      else if (type === "message_stop") {
        const facts = anthropicUsage(usage);
        if (facts.length) yield { type: "usage.reported", facts };
        completed = true;
        yield { type: "execution.completed" };
      } else if (type === "error") {
        throw new RuntimeError("provider_unavailable", "Anthropic message stream failed", {
          retryable: false,
        });
      }
    }
    if (!completed)
      throw new RuntimeError(
        "provider_protocol_error",
        "Anthropic stream ended without message_stop",
      );
  }
}

function toAnthropicPart(part: InputPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "json") return { type: "text", text: JSON.stringify(part.value) };
  if (part.type === "image") return { type: "image", source: { type: "url", url: part.uri } };
  throw new RuntimeError(
    "capability_unavailable",
    `Anthropic adapter does not support ${part.type} input`,
  );
}

function mergeUsage(target: Record<string, number>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source))
    if (typeof value === "number") target[key] = value;
}

function anthropicUsage(usage: Record<string, number>): UsageFact[] {
  return compact([
    fact("input_token", usage.input_tokens),
    fact("output_token", usage.output_tokens),
    fact("cache_write_token", usage.cache_creation_input_tokens),
    fact("cache_read_token", usage.cache_read_input_tokens),
    fact("reasoning_token", usage.thinking_tokens),
  ]);
}

function fact(unit: string, quantity: number | undefined): UsageFact | undefined {
  return quantity === undefined
    ? undefined
    : { unit, quantity, source: "provider", complete: true };
}

function compact(values: (UsageFact | undefined)[]): UsageFact[] {
  return values.filter((value): value is UsageFact => value !== undefined);
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value));
  } catch (error) {
    throw new RuntimeError("provider_protocol_error", "Anthropic returned invalid SSE JSON", {
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

async function resolveSecret(value: AnthropicMessagesProviderOptions["apiKey"]): Promise<string> {
  const secret = typeof value === "function" ? await value() : value;
  if (!secret)
    throw new RuntimeError("provider_unavailable", "Anthropic credential is unavailable");
  return secret;
}
