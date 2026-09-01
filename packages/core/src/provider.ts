import type {
  ExecutionRequest,
  ModelCapability,
  ProviderEvent,
  ProviderManifest,
  ResolvedTarget,
} from "@model-runtime/protocol";

export interface ProviderExecutionContext {
  executionId: string;
  request: ExecutionRequest;
  target: ResolvedTarget;
  signal: AbortSignal;
}

export interface ModelProvider {
  readonly id: string;
  manifest(): Promise<ProviderManifest>;
  execute(context: ProviderExecutionContext): AsyncIterable<ProviderEvent>;
}

export interface ProviderCandidate {
  provider: ModelProvider;
  capability: ModelCapability;
}
