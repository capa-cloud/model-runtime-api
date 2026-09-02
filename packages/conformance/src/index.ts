import type { ModelProvider } from "@model-runtime/core";
import type { ExecutionRequest, ProviderEvent } from "@model-runtime/protocol";
import { protocolVersion } from "@model-runtime/protocol";

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ConformanceReport {
  provider: string;
  passed: boolean;
  checks: ConformanceCheck[];
}

export async function runProviderConformance(provider: ModelProvider): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const manifest = await provider.manifest();
  checks.push(check("manifest.provider", manifest.provider === provider.id));
  checks.push(check("manifest.protocol_version", manifest.protocol_version === protocolVersion));
  checks.push(check("manifest.models", manifest.models.length > 0));

  const capability = manifest.models[0];
  const ability = capability?.abilities[0];
  if (!capability || !ability) {
    checks.push(check("execution.lifecycle", false, "No model ability is available to test"));
    return report(provider.id, checks);
  }

  const inputType = capability.input_modalities.includes("text") ? "text" : undefined;
  if (!inputType) {
    checks.push(
      check("execution.lifecycle", false, "Baseline conformance requires a text input capability"),
    );
    return report(provider.id, checks);
  }

  const request: ExecutionRequest = {
    ability,
    input: [{ type: "text", text: "conformance fixture" }],
    requirements: { input_modalities: ["text"] },
  };
  const controller = new AbortController();
  const events: ProviderEvent[] = [];
  try {
    for await (const event of provider.execute({
      executionId: "execution-conformance",
      request,
      target: { provider: provider.id, model: capability.model },
      signal: controller.signal,
    })) {
      events.push(event);
    }
    const completionCount = events.filter((event) => event.type === "execution.completed").length;
    const invalidUsage = events
      .filter((event) => event.type === "usage.reported")
      .flatMap((event) => event.facts)
      .some((fact) => !fact.unit || !Number.isFinite(fact.quantity) || fact.quantity < 0);
    checks.push(check("execution.completes_once", completionCount === 1));
    checks.push(
      check("execution.completion_is_last", events.at(-1)?.type === "execution.completed"),
    );
    checks.push(check("usage.non_negative", !invalidUsage));

    if (capability.cancel) {
      const cancelController = new AbortController();
      const iterator = provider
        .execute({
          executionId: "execution-conformance-cancel",
          request,
          target: { provider: provider.id, model: capability.model },
          signal: cancelController.signal,
        })
        [Symbol.asyncIterator]();
      await iterator.next();
      cancelController.abort();
      let cancellationObserved = false;
      try {
        await iterator.next();
      } catch (error) {
        cancellationObserved =
          (error instanceof Error && error.name === "AbortError") ||
          (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "cancelled");
      }
      checks.push(check("execution.cancellation", cancellationObserved));
    }
  } catch (error) {
    checks.push(
      check(
        "execution.lifecycle",
        false,
        error instanceof Error ? error.message : "Provider threw a non-error value",
      ),
    );
  }
  return report(provider.id, checks);
}

function check(name: string, passed: boolean, detail?: string): ConformanceCheck {
  return { name, passed, ...(detail ? { detail } : {}) };
}

function report(provider: string, checks: ConformanceCheck[]): ConformanceReport {
  return { provider, passed: checks.every((item) => item.passed), checks };
}
