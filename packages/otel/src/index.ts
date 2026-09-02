import type {
  ExecutionRequest,
  ResolvedTarget,
  RuntimeEvent,
  UsageFact,
} from "@model-runtime/protocol";

export type OtelAttributeValue = string | number | boolean | string[] | number[];

export function executionAttributes(
  request: ExecutionRequest,
  target?: ResolvedTarget,
): Record<string, OtelAttributeValue> {
  return {
    "gen_ai.operation.name": operationName(request.ability),
    "model_runtime.ability": request.ability,
    ...(target
      ? {
          "gen_ai.provider.name": target.provider,
          "gen_ai.request.model": target.model,
        }
      : {}),
  };
}

export function eventAttributes(event: RuntimeEvent): Record<string, OtelAttributeValue> {
  const attributes: Record<string, OtelAttributeValue> = {
    "gen_ai.response.id": event.execution_id,
    "model_runtime.event.sequence": event.sequence,
    "model_runtime.execution.status": event.status,
  };
  if (event.type === "route.selected" || event.type === "execution.completed") {
    attributes["gen_ai.provider.name"] = event.target.provider;
    attributes["gen_ai.response.model"] = event.target.model;
  }
  if (event.type === "usage.reported") Object.assign(attributes, usageAttributes(event.facts));
  if (event.type === "execution.failed") {
    attributes["error.type"] = event.error.code;
    attributes["model_runtime.error.retryable"] = event.error.retryable;
  }
  return attributes;
}

export function usageAttributes(facts: UsageFact[]): Record<string, number> {
  const totals = new Map<string, number>();
  for (const fact of facts) totals.set(fact.unit, (totals.get(fact.unit) ?? 0) + fact.quantity);
  const attributes: Record<string, number> = {};
  assign(attributes, "gen_ai.usage.input_tokens", totals.get("input_token"));
  assign(attributes, "gen_ai.usage.output_tokens", totals.get("output_token"));
  assign(attributes, "gen_ai.usage.cache_creation.input_tokens", totals.get("cache_write_token"));
  assign(attributes, "gen_ai.usage.cache_read.input_tokens", totals.get("cache_read_token"));
  assign(attributes, "gen_ai.usage.reasoning.output_tokens", totals.get("reasoning_token"));
  return attributes;
}

function operationName(ability: string): string {
  if (ability.includes("embedding")) return "embeddings";
  if (["image", "video", "audio", "multimodal"].some((value) => ability.includes(value))) {
    return "generate_content";
  }
  return "chat";
}

function assign(target: Record<string, number>, key: string, value: number | undefined): void {
  if (value !== undefined) target[key] = value;
}
