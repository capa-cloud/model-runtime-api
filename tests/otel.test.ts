import { describe, expect, it } from "vitest";
import { eventAttributes, usageAttributes } from "@model-runtime/otel";

describe("OpenTelemetry mapping", () => {
  it("maps usage without recording model content", () => {
    expect(
      usageAttributes([
        { unit: "input_token", quantity: 5, source: "provider" },
        { unit: "cache_read_token", quantity: 2, source: "provider" },
      ]),
    ).toEqual({
      "gen_ai.usage.input_tokens": 5,
      "gen_ai.usage.cache_read.input_tokens": 2,
    });
    const attributes = eventAttributes({
      type: "output.delta",
      execution_id: "execution-public",
      sequence: 3,
      time: "2026-01-01T00:00:00.000Z",
      status: "running",
      output_index: 0,
      delta: "sensitive fixture",
    });
    expect(JSON.stringify(attributes)).not.toContain("sensitive fixture");
  });
});
