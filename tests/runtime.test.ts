import { describe, expect, it } from "vitest";
import { ModelRuntime } from "@model-runtime/core";
import { MockProvider } from "@model-runtime/provider-mock";
import type { RuntimeEvent } from "@model-runtime/protocol";

describe("ModelRuntime", () => {
  it("routes by required capability and emits a terminal event", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider({ id: "provider-basic" }));
    runtime.register(
      new MockProvider({
        id: "provider-tools",
        model: "model-tools",
        capabilities: { tools: true },
      }),
    );

    const events = await collect(
      runtime.execute({
        ability: "text-generation",
        requirements: { stream: true, tools: true },
        input: [{ type: "text", text: "test fixture" }],
      }),
    );

    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.find((event) => event.type === "route.selected")).toMatchObject({
      target: { provider: "provider-tools", model: "model-tools" },
    });
    expect(events.at(-1)).toMatchObject({ type: "execution.completed", status: "succeeded" });
  });

  it("falls back only after a retryable provider failure", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider({ id: "provider-first", failRetryably: true }));
    runtime.register(new MockProvider({ id: "provider-second" }));

    const events = await collect(
      runtime.execute({
        ability: "text-generation",
        input: [{ type: "text", text: "test fixture" }],
        routing: {
          strategy: "ordered",
          provider_order: ["provider-first", "provider-second"],
          allow_fallback: true,
          max_attempts: 2,
        },
      }),
    );

    expect(events.filter((event) => event.type === "route.selected")).toHaveLength(2);
    expect(events.some((event) => event.type === "route.attempt_failed")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "execution.completed",
      target: { provider: "provider-second" },
    });
  });

  it("fails before provider output when a capability is unavailable", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());

    const events = await collect(
      runtime.execute({
        ability: "text-generation",
        requirements: { async: true },
        input: [{ type: "text", text: "test fixture" }],
      }),
    );

    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { code: "capability_unavailable", retryable: false },
    });
  });

  it("cancels an accepted execution", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider({ delayMs: 100 }));
    const iterator = runtime.execute({
      ability: "text-generation",
      input: [{ type: "text", text: "test fixture" }],
    });
    const accepted = await iterator.next();
    expect(accepted.value?.type).toBe("execution.accepted");
    expect(runtime.cancel(accepted.value?.execution_id ?? "missing")).toBe(true);

    const remaining = await collect(iterator);
    expect(remaining.at(-1)).toMatchObject({
      type: "execution.failed",
      status: "cancelled",
      error: { code: "cancelled" },
    });
  });
});

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
