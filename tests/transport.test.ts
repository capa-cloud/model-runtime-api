import { describe, expect, it } from "vitest";
import { decodeSse, readJsonBody } from "@model-runtime/transport";
import { ModelRuntimeClient } from "@model-runtime/sdk-typescript";

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

async function data(response: Response, limit?: number): Promise<string[]> {
  const values: string[] = [];
  for await (const frame of decodeSse(response, limit)) values.push(frame.data);
  return values;
}

describe("shared bounded transport", () => {
  it.each([
    { chunks: ["data:one\r", "\n\r", "\ndata:two\r", "\n\r", "\n"], expected: ["one", "two"] },
    { chunks: ["data:one\r\rdata:two\r\r"], expected: ["one", "two"] },
    { chunks: [":comment\ndata:  first\ndata:second\n\n"], expected: [" first\nsecond"] },
    { chunks: ["unknown: ignored\ndata:value\n\n"], expected: ["value"] },
    { chunks: ["data:unfinished"], expected: [] },
  ])("decodes SSE framing case %#", async ({ chunks, expected }) => {
    expect(
      await data(responseFromChunks(chunks.map((chunk) => new TextEncoder().encode(chunk)))),
    ).toEqual(expected);
  });

  it("preserves UTF-8 code points split across individual bytes", async () => {
    const text = "\u4f60\u{1f600}";
    const bytes = new TextEncoder().encode(`data:${text}\n\n`);
    expect(
      await data(responseFromChunks(Array.from(bytes, (value) => Uint8Array.of(value)))),
    ).toEqual([text]);
  });

  it("bounds individual events without rejecting a large batch of small frames", async () => {
    expect(await data(new Response("data:123456\n\n".repeat(2000)), 32)).toHaveLength(2000);
  });

  it("checks event size in UTF-8 bytes, not only characters", async () => {
    await expect(data(new Response(`data:${"\u4f60".repeat(20)}\n\n`), 32)).rejects.toThrow(
      "size limit",
    );
  });

  it("cancels an oversized response body", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(100)));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(readJsonBody(response, 32)).rejects.toThrow("size limit");
    expect(cancelled).toBe(true);
  });

  it("cancels an upstream stream when the consumer stops reading", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data:first\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    for await (const frame of decodeSse(response)) {
      expect(frame.data).toBe("first");
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("sanitizes invalid JSON errors rather than echoing response content", async () => {
    await expect(readJsonBody(new Response("fixture-sensitive-content"))).rejects.toThrow(
      "invalid JSON",
    );
    try {
      await readJsonBody(new Response("fixture-sensitive-content"));
    } catch (error) {
      expect(String(error)).not.toContain("fixture-sensitive-content");
    }
  });

  it("shares framing and truncation detection with the TypeScript SDK", async () => {
    const accepted = {
      type: "execution.accepted",
      execution_id: "fixture",
      sequence: 1,
      status: "accepted",
    };
    const terminal = {
      type: "execution.completed",
      execution_id: "fixture",
      sequence: 2,
      status: "succeeded",
    };
    const frames = `: heartbeat\r\ndata:${JSON.stringify(accepted)}\r\n\r\ndata:${JSON.stringify(terminal)}\r\n\r\n`;
    const client = new ModelRuntimeClient({
      baseUrl: "https://runtime.example.test",
      fetch: async () => new Response(frames),
    });
    const events = [];
    for await (const event of client.events("fixture")) events.push(event);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);

    const truncated = new ModelRuntimeClient({
      baseUrl: "https://runtime.example.test",
      fetch: async () => new Response(`data:${JSON.stringify(accepted)}\n\n`),
    });
    const iterator = truncated.events("fixture");
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("before a terminal event");
  });

  it("closes the SDK response on early iteration or an invalid event", async () => {
    for (const payload of ['{"type":"execution.accepted"}', "fixture-sensitive-content"]) {
      let cancelled = false;
      const client = new ModelRuntimeClient({
        baseUrl: "https://runtime.example.test",
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`data:${payload}\n\n`));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      });
      const iterator = client.events("fixture");
      if (payload.startsWith("{")) {
        await iterator.next();
        await iterator.return(undefined);
      } else await expect(iterator.next()).rejects.toThrow("invalid event JSON");
      expect(cancelled).toBe(true);
    }
  });
});
