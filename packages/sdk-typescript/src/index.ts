import type { ExecutionRequest, RuntimeEvent, RuntimeInfo } from "@model-runtime/protocol";

export interface ModelRuntimeClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export class ModelRuntimeClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: ModelRuntimeClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async info(): Promise<RuntimeInfo> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/runtime`);
    if (!response.ok) throw new Error(`Runtime request failed with status ${response.status}`);
    return (await response.json()) as RuntimeInfo;
  }

  async *execute(request: ExecutionRequest): AsyncGenerator<RuntimeEvent> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/executions`, {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Runtime execution failed with status ${response.status}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data) yield JSON.parse(data) as RuntimeEvent;
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async cancel(executionId: string): Promise<boolean> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/executions/${encodeURIComponent(executionId)}/cancel`,
      { method: "POST" },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Runtime cancellation failed with status ${response.status}`);
    return true;
  }
}

export type { ExecutionRequest, RuntimeEvent, RuntimeInfo } from "@model-runtime/protocol";
