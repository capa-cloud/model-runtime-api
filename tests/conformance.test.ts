import { describe, expect, it } from "vitest";
import { runProviderConformance } from "@model-runtime/conformance";
import { MockProvider } from "@model-runtime/provider-mock";

describe("provider conformance", () => {
  it("accepts the deterministic mock provider", async () => {
    const report = await runProviderConformance(new MockProvider());
    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });
});
