import { randomUUID } from "node:crypto";
import type {
  CapabilityRequirements,
  ExecutionRequest,
  ModelCapability,
  ProviderManifest,
  ResolvedTarget,
  RuntimeEvent,
  RuntimeInfo,
} from "@model-runtime/protocol";
import { protocolVersion } from "@model-runtime/protocol";
import { RuntimeError, normalizeError } from "./errors.js";
import { ConcurrencyGate } from "./flow-control.js";
import type { ModelProvider, ProviderCandidate } from "./provider.js";

interface RegisteredProvider {
  provider: ModelProvider;
  gate: ConcurrencyGate;
}

export class ModelRuntime {
  readonly #providers = new Map<string, RegisteredProvider>();
  readonly #executions = new Map<string, AbortController>();

  register(
    provider: ModelProvider,
    limits?: { maxConcurrency?: number; maxQueueDepth?: number },
  ): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
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
      features: {
        routing: true,
        flow_control: true,
        usage_facts: true,
        billing: false,
      },
    };
  }

  async manifests(): Promise<ProviderManifest[]> {
    return Promise.all([...this.#providers.values()].map(({ provider }) => provider.manifest()));
  }

  cancel(executionId: string): boolean {
    const controller = this.#executions.get(executionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async *execute(request: ExecutionRequest): AsyncGenerator<RuntimeEvent> {
    validateRequest(request);
    const executionId = randomUUID();
    const controller = new AbortController();
    const deadline = createDeadline(request.deadline_ms, controller);
    this.#executions.set(executionId, controller);
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
          `No provider satisfies ability: ${request.ability}`,
        );
      }

      const fallback = request.routing?.allow_fallback ?? false;
      const requestedAttempts = request.routing?.max_attempts ?? (fallback ? candidates.length : 1);
      const maxAttempts = Math.max(1, Math.min(requestedAttempts, candidates.length));
      let lastError: RuntimeError | undefined;

      for (let index = 0; index < maxAttempts; index += 1) {
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

        try {
          release = await registered.gate.acquire(controller.signal);
          let completed = false;
          for await (const providerEvent of candidate.provider.execute({
            executionId,
            request,
            target,
            signal: controller.signal,
          })) {
            if (providerEvent.type === "output.delta") {
              yield event({ ...providerEvent, status: "running" });
            } else if (providerEvent.type === "usage.reported") {
              validateUsage(providerEvent.facts);
              yield event({ ...providerEvent, status: "running" });
            } else {
              completed = true;
            }
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
          if (controller.signal.aborted) break;
          if (index + 1 < maxAttempts && lastError.retryable) {
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
            { retryable: deadline.expired },
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
      this.#executions.delete(executionId);
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
  if (!request || typeof request !== "object") {
    throw new RuntimeError("invalid_request", "Request must be an object");
  }
  if (typeof request.ability !== "string" || request.ability.trim() === "") {
    throw new RuntimeError("invalid_request", "ability must be a non-empty string");
  }
  if (!Array.isArray(request.input) || request.input.length === 0) {
    throw new RuntimeError("invalid_request", "input must contain at least one part");
  }
  if (
    request.deadline_ms !== undefined &&
    (!Number.isFinite(request.deadline_ms) || request.deadline_ms < 1)
  ) {
    throw new RuntimeError("invalid_request", "deadline_ms must be a positive number");
  }
}

function validateUsage(facts: { unit: string; quantity: number }[]): void {
  for (const fact of facts) {
    if (!fact.unit || !Number.isFinite(fact.quantity) || fact.quantity < 0) {
      throw new RuntimeError("provider_protocol_error", "Provider reported an invalid usage fact");
    }
  }
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
