import { describe, expect, it } from "vitest";
import { ModelRuntime, RuntimeError } from "@model-runtime/core";
import { MockProvider } from "@model-runtime/provider-mock";
import type { ProviderEvent, RuntimeEvent } from "@model-runtime/protocol";

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

  it.each([
    { label: "text", events: [{ type: "output.delta", output_index: 0, delta: "partial" }] },
    {
      label: "tool call",
      events: [{ type: "tool.call.started", call_id: "call-1", name: "lookup" }],
    },
    { label: "result", events: [{ type: "output.result", result: { partial: true } }] },
  ] satisfies { label: string; events: ProviderEvent[] }[])(
    "does not fall back after exposing $label output",
    async ({ events }) => {
      const runtime = new ModelRuntime();
      const first = new MockProvider({ id: "provider-first" });
      runtime.register({
        id: first.id,
        manifest: () => first.manifest(),
        async *execute() {
          yield* events;
          throw new RuntimeError("provider_unavailable", "Synthetic stream failure", {
            retryable: true,
          });
        },
      });
      runtime.register(new MockProvider({ id: "provider-second", chunks: ["replacement"] }));
      const submission = await runtime.submit({
        ability: "text-generation",
        input: [{ type: "text", text: "fixture" }],
        routing: { allow_fallback: true, max_attempts: 2 },
      });
      await runtime.waitForIdle();
      const stored = await collect(runtime.events(submission.execution_id));
      expect(stored.filter((event) => event.type === "route.selected")).toHaveLength(1);
      expect(stored.at(-1)).toMatchObject({
        type: "execution.failed",
        error: { retryable: false },
      });
      expect(await runtime.get(submission.execution_id)).toMatchObject({
        status: "failed",
        target: { provider: "provider-first" },
      });
      expect(JSON.stringify(stored)).not.toContain("replacement");
    },
  );

  it("honors disabled fallback even when multiple attempts are requested", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider({ id: "provider-first", failRetryably: true }));
    runtime.register(new MockProvider({ id: "provider-second" }));
    const events = await collect(
      runtime.execute({
        ability: "text-generation",
        input: [{ type: "text", text: "fixture" }],
        routing: { allow_fallback: false, max_attempts: 2 },
      }),
    );
    expect(events.filter((event) => event.type === "route.selected")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("execution.failed");
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

  it("replays an idempotent submission and rejects key reuse with another request", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());
    const request = {
      ability: "text-generation",
      input: [{ type: "text" as const, text: "test fixture" }],
    };
    const first = await runtime.submit(request, "request-1");
    const replay = await runtime.submit(request, "request-1");
    expect(replay).toMatchObject({ execution_id: first.execution_id, idempotent_replay: true });
    await expect(
      runtime.submit(
        { ...request, input: [{ type: "text", text: "different fixture" }] },
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await runtime.waitForIdle();
  });

  it("coalesces concurrent submissions with the same idempotency key", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider({ delayMs: 10 }));
    const request = {
      ability: "text-generation",
      input: [{ type: "text" as const, text: "test fixture" }],
    };
    const [first, second] = await Promise.all([
      runtime.submit(request, "request-concurrent"),
      runtime.submit(request, "request-concurrent"),
    ]);
    expect(first.execution_id).toBe(second.execution_id);
    expect([first.idempotent_replay, second.idempotent_replay].sort()).toEqual([false, true]);
    await runtime.waitForIdle();
  });

  it("resumes stored events after a cursor", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());
    const submission = await runtime.submit({
      ability: "text-generation",
      input: [{ type: "text", text: "test fixture" }],
    });
    await runtime.waitForIdle();
    const resumed = await collect(runtime.events(submission.execution_id, 4));
    expect(resumed[0]?.sequence).toBe(5);
    expect(resumed.at(-1)?.type).toBe("execution.completed");
    expect(await runtime.get(submission.execution_id)).toMatchObject({
      status: "succeeded",
      last_sequence: 7,
      result: { outputs: [{ index: 0, type: "text", text: "hello from mock" }] },
    });
  });

  it("rejects fields outside the normative request schema", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());
    const request = {
      ability: "text-generation",
      input: [{ type: "text", text: "test fixture" }],
      unexpected: true,
    };
    await expect(runtime.submit(request as never)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
