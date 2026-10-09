import {
  assertSafeBaseUrl,
  type ModelProvider,
  type ProviderExecutionContext,
  providerHttpError,
  normalizeError,
  readJsonLimited,
  RuntimeError,
} from "@model-runtime/core";
import type {
  ExecutionRequest,
  OutputArtifact,
  ProviderEvent,
  ProviderManifest,
} from "@model-runtime/protocol";
import { protocolVersion } from "@model-runtime/protocol";

export interface FalQueueProviderOptions {
  id?: string;
  apiKey: string | (() => string | Promise<string>);
  model: string;
  ability: string;
  inputModalities?: ProviderManifest["models"][number]["input_modalities"];
  outputModalities?: ProviderManifest["models"][number]["output_modalities"];
  baseUrl?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  cancelTimeoutMs?: number;
  fetch?: typeof fetch;
  mapInput?: (request: ExecutionRequest) => Record<string, unknown>;
}

export class FalQueueProvider implements ModelProvider {
  readonly id: string;
  readonly #options: FalQueueProviderOptions;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;

  constructor(options: FalQueueProviderOptions) {
    if (
      options.pollIntervalMs !== undefined &&
      (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 1)
    ) {
      throw new Error("pollIntervalMs must be a positive integer");
    }
    if (
      options.maxPolls !== undefined &&
      (!Number.isInteger(options.maxPolls) || options.maxPolls < 1)
    ) {
      throw new Error("maxPolls must be a positive integer");
    }
    this.id = options.id ?? "fal";
    if (
      options.cancelTimeoutMs !== undefined &&
      (!Number.isInteger(options.cancelTimeoutMs) ||
        options.cancelTimeoutMs < 1 ||
        options.cancelTimeoutMs > 60_000)
    )
      throw new Error("cancelTimeoutMs must be an integer from 1 to 60000");
    this.#options = options;
    this.#baseUrl = assertSafeBaseUrl(options.baseUrl ?? "https://queue.fal.run");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async manifest(): Promise<ProviderManifest> {
    return {
      provider: this.id,
      protocol_version: protocolVersion,
      models: [
        {
          model: this.#options.model,
          abilities: [this.#options.ability],
          input_modalities: this.#options.inputModalities ?? ["text", "image", "json"],
          output_modalities: this.#options.outputModalities ?? ["image"],
          stream: false,
          tools: false,
          structured_output: false,
          async: true,
          cancel: true,
        },
      ],
    };
  }

  async *execute(context: ProviderExecutionContext): AsyncIterable<ProviderEvent> {
    const apiKey = await resolveSecret(this.#options.apiKey);
    const submitUrl = new URL(
      this.#options.model.replace(/^\/+/, ""),
      withTrailingSlash(this.#baseUrl),
    );
    const response = await this.#fetch(submitUrl, {
      method: "POST",
      headers: { authorization: `Key ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(this.#mapInput(context.request)),
      signal: context.signal,
    }).catch((error) => {
      throw submittedTaskError(error);
    });
    if (!response.ok) throw await providerHttpError(response);
    let cancelUrl: URL | undefined;
    let remoteCompleted = false;
    let cancelTask: Promise<void> | undefined;
    const cancel = () => {
      if (!cancelUrl) return Promise.resolve();
      const url = cancelUrl;
      cancelTask ??= (async () => {
        const response = await this.#fetch(url, {
          method: "PUT",
          headers: { authorization: `Key ${apiKey}` },
          signal: AbortSignal.timeout(this.#options.cancelTimeoutMs ?? 5000),
        });
        await response.body?.cancel();
      })();
      return cancelTask;
    };
    const onAbort = () => {
      if (!remoteCompleted) void cancel().catch(() => undefined);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const submission = asRecord(await readJsonLimited(response));
      cancelUrl = this.#safeFollowUrl(stringValue(submission.cancel_url));
      const statusUrl = this.#safeFollowUrl(stringValue(submission.status_url));
      const resultUrl = this.#safeFollowUrl(stringValue(submission.response_url));
      const maxPolls = this.#options.maxPolls ?? 120;
      for (let poll = 0; poll < maxPolls; poll += 1) {
        if (context.signal.aborted) throw new RuntimeError("cancelled", "Execution was cancelled");
        const statusResponse = await this.#fetch(statusUrl, {
          headers: { authorization: `Key ${apiKey}` },
          signal: context.signal,
        });
        if (!statusResponse.ok) throw await providerHttpError(statusResponse);
        const status = asRecord(await readJsonLimited(statusResponse));
        const value = stringValue(status.status);
        if (value === "IN_QUEUE") {
          yield { type: "execution.progress", phase: "queued" };
        } else if (value === "IN_PROGRESS") {
          yield { type: "execution.progress", phase: "processing" };
        } else if (value === "COMPLETED") {
          remoteCompleted = true;
          if (status.error) {
            throw new RuntimeError("provider_unavailable", "fal queue execution failed", {
              retryable: false,
              providerCode: stringValue(status.error_type),
            });
          }
          const resultResponse = await this.#fetch(resultUrl, {
            headers: { authorization: `Key ${apiKey}` },
            signal: context.signal,
          });
          if (!resultResponse.ok) throw await providerHttpError(resultResponse);
          const result: unknown = await readJsonLimited(resultResponse);
          yield { type: "output.result", result, artifacts: collectArtifacts(result) };
          yield { type: "execution.completed" };
          return;
        } else {
          throw new RuntimeError(
            "provider_protocol_error",
            `fal returned unknown queue status: ${value}`,
          );
        }
        await delay(this.#options.pollIntervalMs ?? 500, context.signal);
      }
      throw new RuntimeError("deadline_exceeded", "fal polling limit was reached", {
        retryable: false,
      });
    } catch (error) {
      throw submittedTaskError(error);
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (!remoteCompleted) await cancel().catch(() => undefined);
    }
  }

  #mapInput(request: ExecutionRequest): Record<string, unknown> {
    if (this.#options.mapInput) return this.#options.mapInput(request);
    const extension = asRecord(request.extensions?.fal);
    const explicit = asRecord(extension.input);
    const prompt = request.input
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const images: string[] = [];
    for (const part of request.input) if (part.type === "image") images.push(part.uri);
    return {
      ...explicit,
      ...(prompt ? { prompt } : {}),
      ...(images.length === 1 ? { image_url: images[0] } : {}),
      ...(images.length > 1 ? { image_urls: images } : {}),
    };
  }

  #safeFollowUrl(value: string): URL {
    if (!value)
      throw new RuntimeError("provider_protocol_error", "fal response omitted a lifecycle URL");
    const url = new URL(value);
    if (url.origin !== this.#baseUrl.origin) {
      throw new RuntimeError("provider_protocol_error", "fal lifecycle URL changed origin");
    }
    return url;
  }
}

function submittedTaskError(error: unknown): RuntimeError {
  const failure = normalizeError(error);
  // Submission or cancellation may have succeeded remotely despite a local error.
  return new RuntimeError(failure.code, failure.message, {
    retryable: false,
    providerCode: failure.providerCode,
    cause: error,
  });
}

function collectArtifacts(value: unknown, depth = 0): OutputArtifact[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectArtifacts(item, depth + 1));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const artifacts: OutputArtifact[] = [];
  const uri =
    typeof record.url === "string"
      ? record.url
      : typeof record.uri === "string"
        ? record.uri
        : undefined;
  if (uri && /^https?:\/\//.test(uri)) {
    artifacts.push({
      uri,
      ...(typeof record.content_type === "string" ? { media_type: record.content_type } : {}),
    });
  }
  for (const nested of Object.values(record))
    artifacts.push(...collectArtifacts(nested, depth + 1));
  return deduplicate(artifacts);
}

function deduplicate(artifacts: OutputArtifact[]): OutputArtifact[] {
  return [...new Map(artifacts.map((artifact) => [artifact.uri, artifact])).values()];
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new RuntimeError("cancelled", "Execution was cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RuntimeError("cancelled", "Execution was cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function withTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}

async function resolveSecret(value: FalQueueProviderOptions["apiKey"]): Promise<string> {
  const secret = typeof value === "function" ? await value() : value;
  if (!secret) throw new RuntimeError("provider_unavailable", "fal credential is unavailable");
  return secret;
}
