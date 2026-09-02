import { describe, expect, it } from "vitest";
import { readJsonLimited, readSse } from "@model-runtime/core";

describe("bounded provider HTTP decoding", () => {
  it("rejects an oversized JSON response", async () => {
    const response = new Response(JSON.stringify({ value: "x".repeat(100) }));
    await expect(readJsonLimited(response, 32)).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects an oversized SSE frame", async () => {
    const response = new Response(`data: ${"x".repeat(100)}\n\n`);
    const iterator = readSse(response, 32)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "provider_protocol_error" });
  });
});
