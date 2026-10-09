import { createParser, type EventSourceMessage } from "eventsource-parser";

export type SseFrame = EventSourceMessage;

export class TransportError extends Error {
  override readonly name = "TransportError";
}

const encoder = new TextEncoder();

export async function* decodeSse(
  response: Response,
  maximumEventBytes = 1024 * 1024,
): AsyncGenerator<SseFrame> {
  validateLimit(maximumEventBytes);
  if (!response.body) throw new TransportError("Response has no stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  const parser = createParser({
    maxBufferSize: maximumEventBytes,
    onEvent(frame) {
      const bytes =
        encoder.encode(frame.data).byteLength +
        encoder.encode(frame.id ?? "").byteLength +
        encoder.encode(frame.event ?? "").byteLength;
      if (bytes > maximumEventBytes) throw new TransportError("SSE event exceeds the size limit");
      frames.push(frame);
    },
    onError(error) {
      if (error.type === "max-buffer-size-exceeded") {
        throw new TransportError("SSE buffer exceeds the size limit");
      }
    },
  });
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      const text = decoder.decode(value, { stream: true });
      // Drain batches independently so a large read containing small events remains valid.
      for (let offset = 0; offset < text.length; offset += 8192) {
        parser.feed(text.slice(offset, offset + 8192));
        yield* frames.splice(0);
      }
    }
    parser.feed(decoder.decode());
    yield* frames.splice(0);
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    parser.reset();
  }
}

export async function readJsonBody(
  response: Response,
  maximumBytes = 4 * 1024 * 1024,
): Promise<unknown> {
  validateLimit(maximumBytes);
  if (!response.body) throw new TransportError("Response has no JSON body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) throw new TransportError("JSON response exceeds the size limit");
      chunks.push(value);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TransportError("Response contains invalid JSON");
  }
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("Response limit must be a positive integer");
}
