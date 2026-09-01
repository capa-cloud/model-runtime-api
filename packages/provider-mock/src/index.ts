import type { ModelProvider, ProviderExecutionContext } from "@model-runtime/core";
import { RuntimeError } from "@model-runtime/core";
import type { ModelCapability, ProviderEvent, ProviderManifest } from "@model-runtime/protocol";
import { protocolVersion } from "@model-runtime/protocol";

export interface MockProviderOptions {
  id?: string;
  model?: string;
  abilities?: string[];
  capabilities?: Partial<ModelCapability>;
  chunks?: string[];
  delayMs?: number;
  failRetryably?: boolean;
}

export class MockProvider implements ModelProvider {
  readonly id: string;
  readonly #capability: ModelCapability;
  readonly #chunks: string[];
  readonly #delayMs: number;
  readonly #failRetryably: boolean;

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? "provider-mock";
    this.#capability = {
      model: options.model ?? "model-alpha",
      abilities: options.abilities ?? ["text-generation"],
      input_modalities: ["text"],
      output_modalities: ["text"],
      stream: true,
      tools: false,
      structured_output: false,
      async: false,
      cancel: true,
      ...options.capabilities,
    };
    this.#chunks = options.chunks ?? ["hello", " from", " mock"];
    this.#delayMs = options.delayMs ?? 0;
    this.#failRetryably = options.failRetryably ?? false;
  }

  async manifest(): Promise<ProviderManifest> {
    return {
      provider: this.id,
      protocol_version: protocolVersion,
      models: [this.#capability],
      limits: { max_concurrency: 4, max_queue_depth: 8 },
    };
  }

  async *execute(context: ProviderExecutionContext): AsyncIterable<ProviderEvent> {
    if (this.#failRetryably) {
      throw new RuntimeError("provider_unavailable", "Mock provider is unavailable", {
        retryable: true,
      });
    }
    for (const chunk of this.#chunks) {
      if (context.signal.aborted) {
        throw new RuntimeError("cancelled", "Execution was cancelled");
      }
      if (this.#delayMs > 0) await delay(this.#delayMs, context.signal);
      yield { type: "output.delta", output_index: 0, delta: chunk };
    }
    yield {
      type: "usage.reported",
      facts: [
        { unit: "input_token", quantity: 1, source: "runtime", complete: true },
        { unit: "output_token", quantity: this.#chunks.length, source: "runtime", complete: true },
      ],
    };
    yield { type: "execution.completed" };
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
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
