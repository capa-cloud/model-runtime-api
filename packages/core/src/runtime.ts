import { createHash, randomUUID } from "node:crypto";
import type {
  CapabilityRequirements,
  ExecutionRequest,
  ExecutionSnapshot,
  ExecutionSubmission,
  ModelCapability,
  ProviderManifest,
  ResolvedTarget,
  RuntimeEvent,
  RuntimeInfo,
} from "@model-runtime/protocol";
import { protocolVersion, validateExecutionRequest } from "@model-runtime/protocol";
import { RuntimeError, normalizeError } from "./errors.js";
import { type EventStore, InMemoryEventStore, type StoredIdentity } from "./event-store.js";
import { ConcurrencyGate } from "./flow-control.js";
import type { ModelProvider, ProviderCandidate } from "./provider.js";

interface RegisteredProvider {
  provider: ModelProvider;
  gate: ConcurrencyGate;
}

interface IdempotencyRecord {
  fingerprint: string;
  submission: Promise<ExecutionSubmission>;
}

export class ModelRuntime {
  readonly #providers = new Map<string, RegisteredProvider>();
  readonly #executions = new Map<string, AbortController>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #submissions = new Set<Promise<ExecutionSubmission>>();
  #closing = false;
  readonly #store: EventStore;
  readonly #admission: ConcurrencyGate;

  constructor(options: { eventStore?: EventStore; maxActiveExecutions?: number } = {}) {
    this.#store = options.eventStore ?? new InMemoryEventStore();
    this.#admission = new ConcurrencyGate(options.maxActiveExecutions ?? 16, 0);
  }

  register(
    provider: ModelProvider,
    limits?: { maxConcurrency?: number; maxQueueDepth?: number },
  ): void {
    this.#assertOpen();
    if (this.#providers.has(provider.id))
      throw new Error(`Provider already registered: ${provider.id}`);
    this.#providers.set(provider.id, {
      provider,
      gate: new ConcurrencyGate(limits?.maxConcurrency, limits?.maxQueueDepth),
    });
  }

  info(): RuntimeInfo {
    return {
      name: "model-runtime-api",
      protocol_version: protocolVersion,
      provider_count: this.#providers.size,
      state: this.#closing
        ? "stopping"
        : this.#store.available?.() === false
          ? "unavailable"
          : "ready",
      features: { routing: true, flow_control: true, usage_facts: true, billing: false },
    };
  }

  async manifests(): Promise<ProviderManifest[]> {
    return Promise.all([...this.#providers.values()].map(({ provider }) => provider.manifest()));
  }

  submit(request: ExecutionRequest, idempotencyKey?: string): Promise<ExecutionSubmission> {
    const operation = this.#submit(request, idempotencyKey);
    this.#submissions.add(operation);
    operation.finally(() => this.#submissions.delete(operation)).catch(() => undefined);
    return operation;
  }

  async #submit(request: ExecutionRequest, idempotencyKey?: string): Promise<ExecutionSubmission> {
    this.#assertOpen();
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 1 ||
        idempotencyKey.length > 256)
    )
      throw new RuntimeError("invalid_request", "Invalid idempotency key length");
    validateRequest(request);
    request = cloneRequest(request);
    const fingerprint = fingerprintRequest(request);
    if (idempotencyKey) {
      const existing = this.#idempotency.get(idempotencyKey);
      if (existing) {
        return this.#replay(existing, fingerprint);
      }
    }

    const identity = idempotencyKey
      ? { key_hash: createHash("sha256").update(idempotencyKey).digest("hex"), fingerprint }
      : undefined;
    if (identity && this.#store.lookupIdentity) {
      const claim = await this.#store.lookupIdentity(identity);
      if (claim) {
        const snapshot = await this.#store.get(claim.execution_id);
        if (!snapshot)
          throw new RuntimeError("queue_full", "Idempotent execution is no longer retained");
        return {
          execution_id: claim.execution_id,
          created_at: claim.created_at,
          status: snapshot.status,
          idempotent_replay: true,
        };
      }
    }
    if (idempotencyKey) {
      const pending = this.#idempotency.get(idempotencyKey);
      if (pending) return this.#replay(pending, fingerprint);
      if (!this.#store.claim && this.#idempotency.size >= 1000)
        throw new RuntimeError("queue_full", "Legacy idempotency cache capacity exhausted");
    }
    const submission = this.#createSubmission(request, identity);
    if (idempotencyKey) this.#idempotency.set(idempotencyKey, { fingerprint, submission });
    try {
      return await submission;
    } catch (error) {
      if (idempotencyKey && this.#idempotency.get(idempotencyKey)?.submission === submission) {
        this.#idempotency.delete(idempotencyKey);
      }
      throw error;
    } finally {
      if (
        this.#store.claim &&
        idempotencyKey &&
        this.#idempotency.get(idempotencyKey)?.submission === submission
      )
        this.#idempotency.delete(idempotencyKey);
    }
  }

  async #replay(existing: IdempotencyRecord, fingerprint: string): Promise<ExecutionSubmission> {
    if (existing.fingerprint !== fingerprint)
      throw new RuntimeError(
        "invalid_request",
        "Idempotency key was already used with a different request",
      );
    const submission = await existing.submission;
    const snapshot = await this.#store.get(submission.execution_id);
    if (!snapshot)
      throw new RuntimeError("queue_full", "Idempotent execution is no longer retained");
    return { ...submission, status: snapshot.status, idempotent_replay: true };
  }

  async #createSubmission(
    request: ExecutionRequest,
    identity?: StoredIdentity,
  ): Promise<ExecutionSubmission> {
    const executionId = randomUUID();
    const createdAt = new Date().toISOString();
    const controller = new AbortController();
    const release = await this.#admission.acquire();
    try {
      if (identity && this.#store.claim) {
        const claim = await this.#store.claim(executionId, createdAt, identity);
        if (claim.replay) {
          release();
          const snapshot = await this.#store.get(claim.execution_id);
          if (!snapshot)
            throw new RuntimeError("internal_error", "Claimed execution is unavailable");
          return {
            execution_id: claim.execution_id,
            created_at: claim.created_at,
            status: snapshot.status,
            idempotent_replay: true,
          };
        }
      } else await this.#store.create(executionId, createdAt);
    } catch (error) {
      release();
      throw error;
    }
    this.#executions.set(executionId, controller);
    if (this.#closing) controller.abort();
    const iterator = this.#run(request, executionId, controller);
    try {
      const first = await iterator.next();
      if (first.value) await this.#store.append(first.value);
      const task = this.#drain(iterator, executionId);
      this.#tasks.add(task);
      task
        .finally(() => {
          this.#tasks.delete(task);
          release();
        })
        .catch(() => undefined);
      return {
        execution_id: executionId,
        status: "accepted",
        created_at: createdAt,
        idempotent_replay: false,
      };
    } catch (error) {
      controller.abort();
      await iterator.return(undefined).catch(() => undefined);
      this.#executions.delete(executionId);
      release();
      await this.#store.discard?.(executionId).catch(() => undefined);
      throw error;
    }
  }

  async get(executionId: string): Promise<ExecutionSnapshot | undefined> {
    return this.#store.get(executionId);
  }

  events(
    executionId: string,
    afterSequence = 0,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    return this.#store.watch(executionId, afterSequence, signal);
  }

  cancel(executionId: string): boolean {
    const controller = this.#executions.get(executionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async *execute(request: ExecutionRequest): AsyncGenerator<RuntimeEvent> {
    this.#assertOpen();
    validateRequest(request);
    request = cloneRequest(request);
    const executionId = randomUUID();
    const controller = new AbortController();
    const release = await this.#admission.acquire();
    this.#executions.set(executionId, controller);
    if (this.#closing) controller.abort();
    try {
      yield* this.#run(request, executionId, controller);
    } finally {
      this.#executions.delete(executionId);
      release();
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#tasks]);
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    for (const controller of this.#executions.values()) controller.abort();
    await Promise.allSettled([...this.#submissions]);
    await Promise.allSettled([...this.#tasks]);
  }

  async close(): Promise<void> {
    await this.shutdown();
    await this.#store.close?.();
  }

  #assertOpen(): void {
    if (this.#closing)
      throw new RuntimeError("provider_unavailable", "Runtime is shutting down", {
        retryable: true,
      });
  }

  async #drain(iterator: AsyncGenerator<RuntimeEvent>, executionId: string): Promise<void> {
    try {
      for await (const event of iterator) await this.#store.append(event);
    } catch (error) {
      this.#executions.get(executionId)?.abort();
      const snapshot = await this.#store.get(executionId);
      if (snapshot && !["succeeded", "failed", "cancelled"].includes(snapshot.status)) {
        const failure =
          error instanceof RuntimeError
            ? error
            : new RuntimeError("internal_error", "Execution event storage failed");
        await this.#store.append({
          type: "execution.failed",
          status: "failed",
          execution_id: executionId,
          sequence: snapshot.last_sequence + 1,
          time: new Date().toISOString(),
          error: failure.toShape(),
        });
      }
    } finally {
      this.#executions.delete(executionId);
    }
  }

  async *#run(
    request: ExecutionRequest,
    executionId: string,
    controller: AbortController,
  ): AsyncGenerator<RuntimeEvent> {
    const deadline = createDeadline(request.deadline_ms, controller);
    const routingStartedAt = Date.now();
    let sequence = 0;
    const event = <T extends Omit<RuntimeEvent, "execution_id" | "sequence" | "time">>(
      value: T,
    ): RuntimeEvent =>
      ({
        ...value,
        execution_id: executionId,
        sequence: ++sequence,
        time: new Date().toISOString(),
      }) as RuntimeEvent;

    try {
      yield event({ type: "execution.accepted", status: "accepted" });
      const candidates = await this.#candidates(request);
      if (candidates.length === 0) {
        throw new RuntimeError(
          "capability_unavailable",
          "No provider satisfies the requested ability and capabilities",
        );
      }
      const fallback = request.routing?.allow_fallback ?? false;
      const requestedAttempts = request.routing?.max_attempts ?? (fallback ? candidates.length : 1);
      const maxAttempts = fallback
        ? Math.max(1, Math.min(requestedAttempts, candidates.length))
        : 1;
      const retryBudgetMs = request.routing?.retry_budget_ms;
      let lastError: RuntimeError | undefined;

      for (let index = 0; index < maxAttempts; index += 1) {
        if (retryBudgetMs && Date.now() - routingStartedAt >= retryBudgetMs) break;
        const candidate = candidates[index];
        if (!candidate) break;
        const target: ResolvedTarget = {
          provider: candidate.provider.id,
          model: candidate.capability.model,
        };
        yield event({ type: "route.selected", status: "routing", target, attempt: index + 1 });
        const registered = this.#providers.get(candidate.provider.id);
        if (!registered) throw new Error("Selected provider is not registered");
        let release: (() => void) | undefined;
        let outputStarted = false;

        try {
          release = await registered.gate.acquire(controller.signal);
          let completed = false;
          for await (const providerEvent of candidate.provider.execute({
            executionId,
            request,
            target,
            signal: controller.signal,
          })) {
            if (
              providerEvent.type === "output.delta" ||
              providerEvent.type === "output.result" ||
              providerEvent.type === "tool.call.started" ||
              providerEvent.type === "tool.call.arguments.delta"
            )
              outputStarted = true;
            if (providerEvent.type === "execution.completed") {
              completed = true;
              break;
            } else if (providerEvent.type === "usage.reported") {
              validateUsage(providerEvent.facts);
              yield event({ ...providerEvent, status: "running" });
            } else yield event({ ...providerEvent, status: "running" });
          }
          if (!completed) {
            throw new RuntimeError(
              "provider_protocol_error",
              "Provider stream ended without a completion event",
            );
          }
          yield event({ type: "execution.completed", status: "succeeded", target });
          return;
        } catch (error) {
          lastError = normalizeError(error);
          // Exposed output cannot be rolled back for streaming consumers.
          if (outputStarted && lastError.retryable) {
            lastError = new RuntimeError(lastError.code, lastError.message, {
              retryable: false,
              providerCode: lastError.providerCode,
              cause: error,
            });
          }
          if (controller.signal.aborted) break;
          const budgetAvailable = !retryBudgetMs || Date.now() - routingStartedAt < retryBudgetMs;
          if (index + 1 < maxAttempts && lastError.retryable && budgetAvailable) {
            yield event({
              type: "route.attempt_failed",
              status: "routing",
              target,
              attempt: index + 1,
              error: lastError.toShape(),
            });
            continue;
          }
          break;
        } finally {
          release?.();
        }
      }

      const failure = controller.signal.aborted
        ? new RuntimeError(
            deadline.expired ? "deadline_exceeded" : "cancelled",
            deadline.expired ? "Execution deadline was exceeded" : "Execution was cancelled",
            { retryable: false },
          )
        : (lastError ??
          new RuntimeError("provider_unavailable", "Execution failed", { retryable: true }));
      yield event({
        type: "execution.failed",
        status: failure.code === "cancelled" ? "cancelled" : "failed",
        error: failure.toShape(),
      });
    } catch (error) {
      const failure = normalizeError(error);
      yield event({
        type: "execution.failed",
        status: failure.code === "cancelled" ? "cancelled" : "failed",
        error: failure.toShape(),
      });
    } finally {
      deadline.clear();
    }
  }

  async #candidates(request: ExecutionRequest): Promise<ProviderCandidate[]> {
    const candidates: ProviderCandidate[] = [];
    for (const { provider } of this.#providers.values()) {
      const manifest = await provider.manifest();
      if (manifest.provider !== provider.id) {
        throw new RuntimeError(
          "provider_protocol_error",
          `Manifest provider does not match registered provider: ${provider.id}`,
        );
      }
      for (const capability of manifest.models) {
        if (
          capability.abilities.includes(request.ability) &&
          request.input.every((part) => capability.input_modalities.includes(part.type)) &&
          satisfies(capability, request.requirements ?? {})
        ) {
          candidates.push({ provider, capability });
        }
      }
    }
    const order = request.routing?.provider_order;
    if (order?.length) {
      const rank = new Map(order.map((provider, index) => [provider, index]));
      candidates.sort(
        (left, right) =>
          (rank.get(left.provider.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.provider.id) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    return candidates;
  }
}

function satisfies(capability: ModelCapability, requirements: CapabilityRequirements): boolean {
  const includesAll = (actual: string[], required?: string[]) =>
    required?.every((item) => actual.includes(item)) ?? true;
  return (
    includesAll(capability.input_modalities, requirements.input_modalities) &&
    includesAll(capability.output_modalities, requirements.output_modalities) &&
    (requirements.stream !== true || capability.stream) &&
    (requirements.tools !== true || capability.tools) &&
    (requirements.structured_output !== true || capability.structured_output) &&
    (requirements.async !== true || capability.async) &&
    (requirements.cancel !== true || capability.cancel)
  );
}

function validateRequest(request: ExecutionRequest): void {
  const validation = validateExecutionRequest(request);
  if (!validation.valid) {
    throw new RuntimeError("invalid_request", "Request does not match the execution schema");
  }
}

function cloneRequest(request: ExecutionRequest): ExecutionRequest {
  try {
    const value = JSON.stringify(request);
    if (Buffer.byteLength(value) > 1024 * 1024) throw new Error("Request limit");
    const copy = JSON.parse(value) as ExecutionRequest;
    validateRequest(copy);
    return copy;
  } catch {
    throw new RuntimeError("invalid_request", "Request must be bounded JSON data");
  }
}

function validateUsage(facts: { unit: string; quantity: number }[]): void {
  for (const fact of facts) {
    if (!fact.unit || !Number.isFinite(fact.quantity) || fact.quantity < 0) {
      throw new RuntimeError("provider_protocol_error", "Provider reported an invalid usage fact");
    }
  }
}

function fingerprintRequest(request: ExecutionRequest): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createDeadline(deadlineMs: number | undefined, controller: AbortController) {
  let expired = false;
  const timer = deadlineMs
    ? setTimeout(() => {
        expired = true;
        controller.abort();
      }, deadlineMs)
    : undefined;
  timer?.unref();
  return {
    get expired() {
      return expired;
    },
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
