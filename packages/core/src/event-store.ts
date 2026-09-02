import type { ExecutionSnapshot, RuntimeEvent } from "@model-runtime/protocol";

export interface EventStore {
  create(executionId: string, createdAt: string): Promise<void>;
  append(event: RuntimeEvent): Promise<void>;
  list(executionId: string, afterSequence?: number): Promise<RuntimeEvent[]>;
  get(executionId: string): Promise<ExecutionSnapshot | undefined>;
  watch(
    executionId: string,
    afterSequence?: number,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent>;
}

interface Entry {
  createdAt: string;
  events: RuntimeEvent[];
  waiters: Set<() => void>;
}

export class InMemoryEventStore implements EventStore {
  readonly #entries = new Map<string, Entry>();

  async create(executionId: string, createdAt: string): Promise<void> {
    if (this.#entries.has(executionId)) throw new Error(`Execution already exists: ${executionId}`);
    this.#entries.set(executionId, { createdAt, events: [], waiters: new Set() });
  }

  async append(event: RuntimeEvent): Promise<void> {
    const entry = this.#entries.get(event.execution_id);
    if (!entry) throw new Error(`Execution does not exist: ${event.execution_id}`);
    if (event.sequence !== (entry.events.at(-1)?.sequence ?? 0) + 1) {
      throw new Error("Event sequence must be contiguous and monotonic");
    }
    entry.events.push(structuredClone(event));
    for (const resolve of entry.waiters) resolve();
    entry.waiters.clear();
  }

  async list(executionId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    return (this.#entries.get(executionId)?.events ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => structuredClone(event));
  }

  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    const entry = this.#entries.get(executionId);
    return entry ? materialize(executionId, entry.createdAt, entry.events) : undefined;
  }

  async *watch(
    executionId: string,
    afterSequence = 0,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    let cursor = afterSequence;
    while (!signal?.aborted) {
      const events = await this.list(executionId, cursor);
      for (const event of events) {
        cursor = event.sequence;
        yield event;
        if (event.type === "execution.completed" || event.type === "execution.failed") return;
      }
      const snapshot = await this.get(executionId);
      if (!snapshot || ["succeeded", "failed", "cancelled"].includes(snapshot.status)) return;
      await this.#wait(executionId, cursor, signal);
    }
  }

  async #wait(executionId: string, cursor: number, signal?: AbortSignal): Promise<void> {
    const entry = this.#entries.get(executionId);
    if (!entry || entry.events.length > cursor || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        entry.waiters.delete(done);
        resolve();
      };
      entry.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (entry.events.length > cursor) done();
    });
  }
}

function materialize(
  executionId: string,
  createdAt: string,
  events: RuntimeEvent[],
): ExecutionSnapshot {
  let status: ExecutionSnapshot["status"] = "accepted";
  let target: ExecutionSnapshot["target"];
  let error: ExecutionSnapshot["error"];
  let result: unknown;
  let artifacts: ExecutionSnapshot["artifacts"];
  const usage: ExecutionSnapshot["usage"] = [];
  const textOutputs = new Map<number, string>();
  const toolCalls = new Map<string, { call_id: string; name: string; arguments: string }>();
  for (const event of events) {
    status = event.status;
    if (event.type === "route.selected" || event.type === "execution.completed")
      target = event.target;
    else if (event.type === "execution.failed") error = event.error;
    else if (event.type === "usage.reported") usage.push(...event.facts);
    else if (event.type === "output.delta") {
      textOutputs.set(
        event.output_index,
        `${textOutputs.get(event.output_index) ?? ""}${event.delta}`,
      );
    } else if (event.type === "tool.call.started") {
      toolCalls.set(event.call_id, { call_id: event.call_id, name: event.name, arguments: "" });
    } else if (event.type === "tool.call.arguments.delta") {
      const call = toolCalls.get(event.call_id);
      if (call) call.arguments += event.delta;
    } else if (event.type === "output.result") {
      result = event.result;
      artifacts = event.artifacts;
    }
  }
  if (result === undefined && (textOutputs.size || toolCalls.size)) {
    result = {
      outputs: [...textOutputs.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, text]) => ({ index, type: "text", text })),
      tool_calls: [...toolCalls.values()],
    };
  }
  return {
    execution_id: executionId,
    status,
    created_at: createdAt,
    updated_at: events.at(-1)?.time ?? createdAt,
    last_sequence: events.at(-1)?.sequence ?? 0,
    usage,
    ...(target ? { target } : {}),
    ...(error ? { error } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}
