import { describe, expect, it } from "vitest";
import { InMemoryEventStore, ModelRuntime } from "@model-runtime/core";
import { MockProvider } from "@model-runtime/provider-mock";
import type { RuntimeEvent } from "@model-runtime/protocol";

const request = { ability: "text-generation", input: [{ type: "text" as const, text: "fixture" }] };

describe("runtime shutdown", () => {
  it("cancels active and queued work before finishing and rejects further admission", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider({ delayMs: 1000 }), { maxConcurrency: 1 });
    const first = await runtime.submit(request);
    const second = await runtime.submit(request);
    await runtime.shutdown();
    for (const submission of [first, second]) {
      expect(await runtime.get(submission.execution_id)).toMatchObject({ status: "cancelled" });
      expect(runtime.cancel(submission.execution_id)).toBe(false);
    }
    await expect(runtime.submit(request)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(() => runtime.register(new MockProvider({ id: "provider-b" }))).toThrow("shutting down");
    await expect(runtime.execute(request).next()).rejects.toThrow("shutting down");
    await runtime.shutdown();
  });

  it("includes submissions whose store creation is still pending", async () => {
    let release!: () => void;
    class SlowStore extends InMemoryEventStore {
      override async create(id: string, createdAt: string): Promise<void> {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await super.create(id, createdAt);
      }
    }
    const runtime = new ModelRuntime({ eventStore: new SlowStore() });
    runtime.register(new MockProvider());
    const submission = runtime.submit(request);
    await expect.poll(() => typeof release).toBe("function");
    let finished = false;
    const stopping = runtime.shutdown().then(() => {
      finished = true;
    });
    expect(finished).toBe(false);
    release();
    const accepted = await submission;
    await stopping;
    expect(await runtime.get(accepted.execution_id)).toMatchObject({ status: "cancelled" });
  });

  it("cleans up the controller and idempotency record when the first append fails", async () => {
    let failedId = "";
    let fail = true;
    class FailingStore extends InMemoryEventStore {
      override async append(event: RuntimeEvent): Promise<void> {
        if (fail) {
          fail = false;
          failedId = event.execution_id;
          throw new Error("Synthetic append failure");
        }
        await super.append(event);
      }
    }
    const runtime = new ModelRuntime({ eventStore: new FailingStore() });
    runtime.register(new MockProvider());
    await expect(runtime.submit(request, "fixture-key")).rejects.toThrow("append failure");
    expect(runtime.cancel(failedId)).toBe(false);
    const replay = await runtime.submit(request, "fixture-key");
    expect(replay.execution_id).not.toBe(failedId);
    await runtime.shutdown();
  });
});
