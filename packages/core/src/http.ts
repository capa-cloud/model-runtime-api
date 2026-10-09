import { decodeSse, readJsonBody, TransportError } from "@model-runtime/transport";
import { RuntimeError } from "./errors.js";

export type { SseFrame } from "@model-runtime/transport";

export async function* readSse(response: Response, maximumFrameBytes = 1024 * 1024) {
  try {
    yield* decodeSse(response, maximumFrameBytes);
  } catch (error) {
    if (error instanceof TransportError)
      throw new RuntimeError("provider_protocol_error", error.message);
    throw error;
  }
}

export async function readJsonLimited(
  response: Response,
  maximumBytes = 4 * 1024 * 1024,
): Promise<unknown> {
  try {
    return await readJsonBody(response, maximumBytes);
  } catch (error) {
    if (error instanceof TransportError)
      throw new RuntimeError("provider_protocol_error", error.message);
    throw error;
  }
}

export function assertSafeBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new Error(
      "Provider base URL must be HTTPS or loopback HTTP without credentials, query or fragments",
    );
  }
  url.search = "";
  url.hash = "";
  return url;
}

export async function providerHttpError(response: Response): Promise<RuntimeError> {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const code = response.status === 429 ? "rate_limited" : "provider_unavailable";
  await response.body?.cancel().catch(() => undefined);
  return new RuntimeError(code, `Provider request failed with status ${response.status}`, {
    retryable,
    providerCode: String(response.status),
  });
}
