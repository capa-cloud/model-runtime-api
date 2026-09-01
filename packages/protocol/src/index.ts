export const protocolVersion = "0.1.0";

export type Modality = "text" | "image" | "audio" | "video" | "file" | "json";

export type ExecutionStatus =
  | "accepted"
  | "routing"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RuntimeErrorCode =
  | "invalid_request"
  | "capability_unavailable"
  | "queue_full"
  | "rate_limited"
  | "deadline_exceeded"
  | "cancelled"
  | "provider_unavailable"
  | "provider_protocol_error"
  | "internal_error";

export interface RuntimeErrorShape {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
  provider_code?: string;
}

export type InputPart =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | { type: "image" | "audio" | "video" | "file"; uri: string; media_type?: string };

export interface CapabilityRequirements {
  input_modalities?: Modality[];
  output_modalities?: Modality[];
  stream?: boolean;
  tools?: boolean;
  structured_output?: boolean;
  async?: boolean;
  cancel?: boolean;
}

export interface ModelCapability extends Required<CapabilityRequirements> {
  model: string;
  abilities: string[];
}

export interface ProviderManifest {
  provider: string;
  protocol_version: string;
  models: ModelCapability[];
  limits?: {
    max_concurrency?: number;
    max_queue_depth?: number;
  };
}

export interface RoutingRequest {
  strategy?: "first_available" | "ordered";
  provider_order?: string[];
  allow_fallback?: boolean;
  max_attempts?: number;
}

export interface ExecutionRequest {
  ability: string;
  input: InputPart[];
  requirements?: CapabilityRequirements;
  routing?: RoutingRequest;
  deadline_ms?: number;
  metadata?: Record<string, string | number | boolean>;
  extensions?: Record<string, unknown>;
}

export interface ResolvedTarget {
  provider: string;
  model: string;
}

export type KnownUsageUnit =
  | "input_token"
  | "output_token"
  | "cache_write_token"
  | "cache_read_token"
  | "reasoning_token"
  | "embedding_input_token"
  | "image_count"
  | "video_second"
  | "audio_input_second"
  | "audio_output_second"
  | "tool_request"
  | "request";

export interface UsageFact {
  unit: KnownUsageUnit | (string & {});
  quantity: number;
  source: "provider" | "runtime";
  complete?: boolean;
}

interface EventBase {
  execution_id: string;
  sequence: number;
  time: string;
}

export type RuntimeEvent =
  | (EventBase & {
      type: "execution.accepted";
      status: "accepted";
    })
  | (EventBase & {
      type: "route.selected";
      status: "routing";
      target: ResolvedTarget;
      attempt: number;
    })
  | (EventBase & {
      type: "route.attempt_failed";
      status: "routing";
      target: ResolvedTarget;
      attempt: number;
      error: RuntimeErrorShape;
    })
  | (EventBase & {
      type: "output.delta";
      status: "running";
      output_index: number;
      delta: string;
    })
  | (EventBase & {
      type: "usage.reported";
      status: "running";
      facts: UsageFact[];
    })
  | (EventBase & {
      type: "execution.completed";
      status: "succeeded";
      target: ResolvedTarget;
    })
  | (EventBase & {
      type: "execution.failed";
      status: "failed" | "cancelled";
      error: RuntimeErrorShape;
    });

export type ProviderEvent =
  | {
      type: "output.delta";
      output_index: number;
      delta: string;
    }
  | {
      type: "usage.reported";
      facts: UsageFact[];
    }
  | {
      type: "execution.completed";
    };

export interface RuntimeInfo {
  name: "model-runtime-api";
  protocol_version: string;
  provider_count: number;
  features: {
    routing: true;
    flow_control: true;
    usage_facts: true;
    billing: false;
  };
}

export function isTerminalEvent(event: RuntimeEvent): boolean {
  return event.type === "execution.completed" || event.type === "execution.failed";
}
