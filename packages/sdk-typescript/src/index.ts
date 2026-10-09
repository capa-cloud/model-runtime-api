import type {
  ExecutionRequest,
  ExecutionSnapshot,
  ExecutionSubmission,
  RuntimeEvent,
  RuntimeInfo,
} from "@model-runtime/protocol";
import { decodeSse, readJsonBody } from "@model-runtime/transport";

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
      baseUrl.hash ||
      baseUrl.search
    ) {
      throw new Error(
        "Runtime base URL must be HTTP or HTTPS without credentials, query or fragments",
      );
    }
    baseUrl.search = "";
    baseUrl.hash = "";
    this.#baseUrl = baseUrl.href.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async info(): Promise<RuntimeInfo> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/runtime`);
    if (!response.ok) {
      await discard(response);
      throw new Error(`Runtime request failed with status ${response.status}`);
    }
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
      await discard(response);
      throw new Error(`Runtime execution failed with status ${response.status}`);
    }
    return readJsonResponse<ExecutionSubmission>(response);
  }

  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/executions/${encodeURIComponent(executionId)}`,
    );
    if (response.status === 404) {
      await discard(response);
      return undefined;
    }
    if (!response.ok) {
      await discard(response);
      throw new Error(`Runtime request failed with status ${response.status}`);
    }
    return readJsonResponse<ExecutionSnapshot>(response);
  }

  async *events(executionId: string, afterSequence = 0): AsyncGenerator<RuntimeEvent> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new RangeError("Event cursor must be a non-negative integer");
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/executions/${encodeURIComponent(executionId)}/events?after=${afterSequence}`,
      { headers: { accept: "text/event-stream" } },
    );
    if (!response.ok || !response.body) {
      await discard(response);
      throw new Error(`Runtime event stream failed with status ${response.status}`);
    }

    let lastEvent: RuntimeEvent | undefined;
    for await (const frame of decodeSse(response)) {
      try {
        lastEvent = JSON.parse(frame.data) as RuntimeEvent;
      } catch {
        throw new Error("Runtime returned invalid event JSON");
      }
      yield lastEvent;
    }
    if (
      lastEvent &&
      lastEvent.type !== "execution.completed" &&
      lastEvent.type !== "execution.failed"
    ) {
      throw new Error("Runtime event stream ended before a terminal event");
    }
  }

  async result(executionId: string): Promise<unknown> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/executions/${encodeURIComponent(executionId)}/result`,
    );
    if (!response.ok) {
      await discard(response);
      throw new Error(`Runtime result failed with status ${response.status}`);
    }
    return readJsonResponse<unknown>(response);
  }

  async cancel(executionId: string): Promise<boolean> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/executions/${encodeURIComponent(executionId)}/cancel`,
      { method: "POST" },
    );
    await discard(response);
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
  return (await readJsonBody(response, maximumBytes)) as T;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
