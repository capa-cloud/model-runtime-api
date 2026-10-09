import type { ExecutionSnapshot, RuntimeEvent } from "@model-runtime/protocol";
import { RuntimeError } from "./errors.js";

export interface StoredIdentity {
  key_hash: string;
  fingerprint: string;
}
export interface StoreClaim {
  execution_id: string;
  created_at: string;
  replay: boolean;
}
export interface EventStore {
  create(executionId: string, createdAt: string): Promise<void>;
  claim?(executionId: string, createdAt: string, identity: StoredIdentity): Promise<StoreClaim>;
  lookupIdentity?(identity: StoredIdentity): Promise<StoreClaim | undefined>;
  append(event: RuntimeEvent): Promise<void>;
  list(executionId: string, afterSequence?: number): Promise<RuntimeEvent[]>;
  get(executionId: string): Promise<ExecutionSnapshot | undefined>;
  watch(
    executionId: string,
    afterSequence?: number,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent>;
  close?(): Promise<void>;
  discard?(executionId: string): Promise<void>;
  available?(): boolean;
}

export interface EventStoreLimits {
  maxExecutions?: number;
  maxBytes?: number;
  maxExecutionBytes?: number;
  maxEvents?: number;
  retentionMs?: number;
  now?: () => number;
}

export interface StoreEntry {
  createdAt: string;
  identity?: StoredIdentity;
  events: RuntimeEvent[];
  bytes: number;
  waiters: Set<() => void>;
  readers: number;
}

export class InMemoryEventStore implements EventStore {
  protected readonly entries = new Map<string, StoreEntry>();
  protected readonly limits: Required<EventStoreLimits>;
  protected bytes = 0;
  #writes: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(limits: EventStoreLimits = {}) {
    this.limits = {
      maxExecutions: limits.maxExecutions ?? 1000,
      maxBytes: limits.maxBytes ?? 64 * 1024 * 1024,
      maxExecutionBytes: limits.maxExecutionBytes ?? 4 * 1024 * 1024,
      maxEvents: limits.maxEvents ?? 4096,
      retentionMs: limits.retentionMs ?? 24 * 60 * 60 * 1000,
      now: limits.now ?? Date.now,
    };
    for (const value of [
      this.limits.maxExecutions,
      this.limits.maxBytes,
      this.limits.maxExecutionBytes,
      this.limits.maxEvents,
      this.limits.retentionMs,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Store limits must be positive integers");
    }
  }

  create(executionId: string, createdAt: string): Promise<void> {
    return this.write(() => this.createEntry(executionId, createdAt));
  }

  claim(executionId: string, createdAt: string, identity: StoredIdentity): Promise<StoreClaim> {
    return this.write(async () => {
      await this.expire();
      for (const [id, entry] of this.entries) {
        if (entry.identity?.key_hash === identity.key_hash) {
          if (entry.identity.fingerprint !== identity.fingerprint) {
            throw new RuntimeError(
              "invalid_request",
              "Idempotency key was already used with a different request",
            );
          }
          return { execution_id: id, created_at: entry.createdAt, replay: true };
        }
      }
      if (
        !/^[a-f0-9]{64}$/.test(identity.key_hash) ||
        !/^[a-f0-9]{64}$/.test(identity.fingerprint)
      ) {
        throw new RuntimeError("invalid_request", "Invalid stored identity");
      }
      await this.createEntry(executionId, createdAt, identity);
      return { execution_id: executionId, created_at: createdAt, replay: false };
    });
  }
  lookupIdentity(identity: StoredIdentity): Promise<StoreClaim | undefined> {
    return this.write(async () => {
      await this.expire();
      for (const [id, entry] of this.entries) {
        if (entry.identity?.key_hash === identity.key_hash) {
          if (entry.identity.fingerprint !== identity.fingerprint)
            throw new RuntimeError(
              "invalid_request",
              "Idempotency key was already used with a different request",
            );
          return { execution_id: id, created_at: entry.createdAt, replay: true };
        }
      }
      return undefined;
    });
  }

  protected async createEntry(
    id: string,
    createdAt: string,
    identity?: StoredIdentity,
  ): Promise<void> {
    if (!id || id.length > 256 || !Number.isFinite(Date.parse(createdAt)) || this.entries.has(id)) {
      throw new RuntimeError("internal_error", "Invalid or duplicate store entry");
    }
    const entry: StoreEntry = {
      createdAt,
      identity,
      events: [],
      bytes: 256,
      waiters: new Set(),
      readers: 0,
    };
    await this.ensureRoom(entry.bytes, true);
    await this.persistCreate(id, entry);
    this.entries.set(id, entry);
    this.bytes += entry.bytes;
  }

  append(event: RuntimeEvent): Promise<void> {
    return this.write(async () => {
      const entry = this.entries.get(event.execution_id);
      if (!entry) throw new RuntimeError("internal_error", "Store entry is unavailable");
      assertEvent(event);
      if (terminal(entry) || event.sequence !== (entry.events.at(-1)?.sequence ?? 0) + 1) {
        throw new RuntimeError("internal_error", "Event sequence or terminal state is invalid");
      }
      const copy = structuredClone(event);
      const size = Buffer.byteLength(JSON.stringify(copy));
      const final = isTerminal(event);
      if (final && size > 2048)
        throw new RuntimeError("internal_error", "Terminal event exceeds its reserve");
      if (
        !final &&
        (entry.events.length >= this.limits.maxEvents ||
          entry.bytes + size > this.limits.maxExecutionBytes)
      ) {
        throw new RuntimeError("queue_full", "Execution event capacity exhausted");
      }
      if (!final) await this.ensureRoom(size, false, event.execution_id);
      await this.persistAppend(event.execution_id, copy);
      entry.events.push(copy);
      entry.bytes += size;
      this.bytes += size;
      for (const resolve of entry.waiters) resolve();
      entry.waiters.clear();
    });
  }

  async list(executionId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new RuntimeError("invalid_request", "Invalid event cursor");
    await this.write(() => this.expire());
    return (this.entries.get(executionId)?.events ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => structuredClone(event));
  }

  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    await this.write(() => this.expire());
    const entry = this.entries.get(executionId);
    return entry ? materialize(executionId, entry.createdAt, entry.events) : undefined;
  }

  async *watch(
    executionId: string,
    afterSequence = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeEvent> {
    this.assertAvailable();
    const pinned = this.entries.get(executionId);
    if (!pinned) return;
    pinned.readers += 1;
    let cursor = afterSequence;
    try {
      while (!signal?.aborted) {
        for (const event of await this.list(executionId, cursor)) {
          cursor = event.sequence;
          yield event;
          if (isTerminal(event)) return;
        }
        const snapshot = await this.get(executionId);
        if (!snapshot) return;
        if (snapshot.last_sequence > cursor) continue;
        if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) return;
        await this.wait(executionId, cursor, signal);
      }
    } finally {
      pinned.readers -= 1;
    }
  }

  protected write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(() => {
      this.assertAvailable();
      return operation();
    });
    this.#writes = result.catch(() => undefined);
    return result;
  }
  discard(id: string): Promise<void> {
    return this.write(async () => {
      const entry = this.entries.get(id);
      if (entry?.events.length)
        throw new RuntimeError("internal_error", "Cannot discard committed execution events");
      await this.remove(id);
    });
  }
  protected assertAvailable(): void {
    if (this.#closed) throw new RuntimeError("internal_error", "Event store is closed");
  }
  available(): boolean {
    return !this.#closed;
  }
  close(): Promise<void> {
    return this.write(async () => {
      this.#closed = true;
      for (const entry of this.entries.values()) for (const wake of entry.waiters) wake();
      this.entries.clear();
      this.bytes = 0;
    });
  }
  protected async persistCreate(_id: string, _entry: StoreEntry): Promise<void> {}
  protected async persistAppend(_id: string, _event: RuntimeEvent): Promise<void> {}
  protected async persistDelete(_id: string): Promise<void> {}

  protected async expire(): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (
        terminal(entry) &&
        entry.readers === 0 &&
        this.limits.now() - Date.parse(entry.events.at(-1)!.time) >= this.limits.retentionMs
      ) {
        await this.remove(id);
      }
    }
  }
  protected async ensureRoom(
    additional: number,
    creating: boolean,
    exclude?: string,
  ): Promise<void> {
    await this.expire();
    while (
      this.bytes + additional > this.limits.maxBytes ||
      (creating && this.entries.size >= this.limits.maxExecutions)
    ) {
      if (!(await this.evictOldest(exclude)))
        throw new RuntimeError("queue_full", "Event store capacity exhausted");
    }
  }
  protected async evictOldest(exclude?: string): Promise<boolean> {
    const candidate = [...this.entries]
      .filter(([id, entry]) => id !== exclude && terminal(entry) && entry.readers === 0)
      .sort(
        (a, b) => Date.parse(a[1].events.at(-1)!.time) - Date.parse(b[1].events.at(-1)!.time),
      )[0];
    if (!candidate) return false;
    await this.remove(candidate[0]);
    return true;
  }
  protected async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await this.persistDelete(id);
    this.entries.delete(id);
    this.bytes -= entry.bytes;
    for (const resolve of entry.waiters) resolve();
  }
  private async wait(id: string, cursor: number, signal?: AbortSignal): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.events.length > cursor || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        entry.waiters.delete(done);
        resolve();
      };
      entry.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (entry.events.length > cursor || signal?.aborted || !this.entries.has(id)) done();
    });
  }
}

function terminal(entry: StoreEntry): boolean {
  return Boolean(entry.events.length && isTerminal(entry.events.at(-1)!));
}
export function isTerminal(event: RuntimeEvent): boolean {
  return event.type === "execution.completed" || event.type === "execution.failed";
}
export function assertEvent(event: RuntimeEvent): void {
  const statuses: Record<string, string[]> = {
    "execution.accepted": ["accepted"],
    "route.selected": ["routing"],
    "route.attempt_failed": ["routing"],
    "output.delta": ["running"],
    "tool.call.started": ["running"],
    "tool.call.arguments.delta": ["running"],
    "execution.progress": ["running"],
    "output.result": ["running"],
    "usage.reported": ["running"],
    "execution.completed": ["succeeded"],
    "execution.failed": ["failed", "cancelled"],
  };
  if (
    !event ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    !event.execution_id ||
    !Number.isFinite(Date.parse(event.time)) ||
    !Object.hasOwn(statuses, event.type) ||
    !statuses[event.type]!.includes(event.status)
  )
    throw new RuntimeError("internal_error", "Invalid stored event");
  if (
    event.type === "output.delta" &&
    (typeof event.delta !== "string" ||
      !Number.isSafeInteger(event.output_index) ||
      event.output_index < 0)
  )
    throw new RuntimeError("internal_error", "Invalid output event");
  if (
    event.type === "tool.call.started" &&
    (typeof event.call_id !== "string" || typeof event.name !== "string")
  )
    throw new RuntimeError("internal_error", "Invalid tool event");
  if (
    event.type === "tool.call.arguments.delta" &&
    (typeof event.call_id !== "string" || typeof event.delta !== "string")
  )
    throw new RuntimeError("internal_error", "Invalid tool event");
  if (
    (event.type === "route.selected" || event.type === "execution.completed") &&
    (!event.target ||
      typeof event.target.provider !== "string" ||
      typeof event.target.model !== "string")
  )
    throw new RuntimeError("internal_error", "Invalid target event");
  if (
    event.type === "execution.failed" &&
    (!event.error ||
      typeof event.error.code !== "string" ||
      typeof event.error.message !== "string" ||
      typeof event.error.retryable !== "boolean")
  )
    throw new RuntimeError("internal_error", "Invalid failure event");
  if (
    event.type === "usage.reported" &&
    (!Array.isArray(event.facts) ||
      event.facts.some(
        (fact) =>
          typeof fact.unit !== "string" || !Number.isFinite(fact.quantity) || fact.quantity < 0,
      ))
  )
    throw new RuntimeError("internal_error", "Invalid usage event");
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
