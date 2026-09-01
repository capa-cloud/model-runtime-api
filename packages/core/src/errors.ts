import type { RuntimeErrorCode, RuntimeErrorShape } from "@model-runtime/protocol";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: { retryable?: boolean; providerCode?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.providerCode = options.providerCode;
  }

  toShape(): RuntimeErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.providerCode ? { provider_code: this.providerCode } : {}),
    };
  }
}

export function normalizeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new RuntimeError("cancelled", "Execution was cancelled");
  }
  return new RuntimeError("provider_unavailable", "Provider execution failed", {
    retryable: true,
    cause: error,
  });
}
