import type {
  ExecutionRequest,
  ExecutionSnapshot,
  ExecutionSubmission,
  RuntimeEvent,
  RuntimeInfo,
} from "@model-runtime/protocol";

export interface ModelRuntimeClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export class ModelRuntimeClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: ModelRuntimeClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.hash
    ) {
      throw new Error("Runtime base URL must be HTTP or HTTPS without credentials or fragments");
    }
    this.#baseUrl = baseUrl.href.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async info(): Promise<RuntimeInfo> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/runtime`);
    if (!response.ok) throw new Error(`Runtime request failed with status ${response.status}`);
    return readJsonResponse<RuntimeInfo>(response);
  }

  async *execute(request: ExecutionRequest): AsyncGenerator<RuntimeEvent> {
    const submission = await this.submit(request);
    yield* this.events(submission.execution_id);
  }

  async submit(request: ExecutionRequest, idempotencyKey?: string): Promise<ExecutionSubmission> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/executions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`Runtime execution failed with status ${response.status}`);
    }
    return readJsonResponse<ExecutionSubmission>(response);
  }

  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/executions/${encodeURIComponent(executionId)}`,
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Runtime request failed with status ${response.status}`);
    return readJsonResponse<ExecutionSnapshot>(response);
  }

  async *events(executionId: string, afterSequence = 0): AsyncGenerator<RuntimeEvent> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/executions/${encodeURIComponent(executionId)}/events?after=${afterSequence}`,
      { headers: { accept: "text/event-stream" } },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Runtime event stream failed with status ${response.status}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        if (new TextEncoder().encode(buffer).byteLength > 1024 * 1024) {
          throw new Error("Runtime SSE frame exceeds 1 MiB");
        }
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
      buffer += decoder.decode().replace(/\r\n/g, "\n");
      const data = buffer
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data) yield JSON.parse(data) as RuntimeEvent;
    } finally {
      reader.releaseLock();
    }
  }

  async result(executionId: string): Promise<unknown> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/executions/${encodeURIComponent(executionId)}/result`,
    );
    if (!response.ok) throw new Error(`Runtime result failed with status ${response.status}`);
    return readJsonResponse<unknown>(response);
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

export type {
  ExecutionRequest,
  ExecutionSnapshot,
  ExecutionSubmission,
  RuntimeEvent,
  RuntimeInfo,
} from "@model-runtime/protocol";

async function readJsonResponse<T>(response: Response, maximumBytes = 4 * 1024 * 1024): Promise<T> {
  if (!response.body) throw new Error("Runtime returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("Runtime JSON response exceeds 4 MiB");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
