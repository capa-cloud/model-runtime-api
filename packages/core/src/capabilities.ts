import type { ModelCapability, Modality, ExecutionRequest } from "@model-runtime/protocol";
import { RuntimeError } from "./errors.js";

export interface TextProviderCapabilities {
  input_modalities?: Modality[];
  tools?: boolean;
}

export function declaredModalities(
  value: Modality[] | undefined,
  fallback: Modality[],
  supported: readonly Modality[],
): Modality[] {
  const result = value === undefined ? fallback : value;
  if (
    !Array.isArray(result) ||
    result.length === 0 ||
    result.length > supported.length ||
    new Set(result).size !== result.length ||
    result.some((item) => !supported.includes(item))
  )
    throw new RuntimeError("invalid_request", "Invalid adapter modality declaration");
  return [...result];
}

export function textCapabilities(
  value: TextProviderCapabilities | undefined,
  supported: readonly Modality[],
): Pick<ModelCapability, "input_modalities" | "tools"> {
  if (
    value !== undefined &&
    (!value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !["input_modalities", "tools"].includes(key)) ||
      (value.tools !== undefined && typeof value.tools !== "boolean"))
  )
    throw new RuntimeError("invalid_request", "Invalid text adapter capability declaration");
  return {
    input_modalities: declaredModalities(value?.input_modalities, ["text", "json"], supported),
    tools: value?.tools ?? false,
  };
}

export function assertTextCapabilities(
  request: ExecutionRequest,
  capability: Pick<ModelCapability, "input_modalities" | "tools">,
  extension: Record<string, unknown>,
): void {
  if (
    request.input.some((part) => !capability.input_modalities.includes(part.type)) ||
    request.requirements?.structured_output === true ||
    (request.requirements?.tools === true && !capability.tools) ||
    (!capability.tools && (extension.tools !== undefined || extension.tool_choice !== undefined))
  )
    throw new RuntimeError(
      "capability_unavailable",
      "Request exceeds configured adapter capabilities",
    );
}
