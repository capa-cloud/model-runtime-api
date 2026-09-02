import { RuntimeError } from "./errors.js";

export interface SseFrame {
  event?: string;
  id?: string;
  data: string;
}

export async function* readSse(
  response: Response,
  maximumFrameBytes = 1024 * 1024,
): AsyncGenerator<SseFrame> {
  if (!response.body) {
    throw new RuntimeError("provider_protocol_error", "Provider returned an empty stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      if (Buffer.byteLength(buffer, "utf8") > maximumFrameBytes) {
        throw new RuntimeError(
          "provider_protocol_error",
          "Provider SSE frame exceeds the size limit",
        );
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, "\n");
    const frame = parseFrame(buffer);
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonLimited(
  response: Response,
  maximumBytes = 4 * 1024 * 1024,
): Promise<unknown> {
  if (!response.body)
    throw new RuntimeError("provider_protocol_error", "Provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new RuntimeError(
          "provider_protocol_error",
          "Provider JSON response exceeds the size limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new RuntimeError("provider_protocol_error", "Provider returned invalid JSON", {
      cause: error,
    });
  }
}

export function assertSafeBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new Error(
      "Provider base URL must be HTTPS or loopback HTTP without credentials or fragments",
    );
  }
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

function parseFrame(raw: string): SseFrame | undefined {
  if (!raw || raw.startsWith(":")) return undefined;
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length
    ? { ...(event ? { event } : {}), ...(id ? { id } : {}), data: data.join("\n") }
    : undefined;
}
