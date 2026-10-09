import { describe, expect, it } from "vitest";
import { ModelRuntime } from "@model-runtime/core";
import { FalQueueProvider } from "@model-runtime/provider-fal";
import { MockProvider } from "@model-runtime/provider-mock";
import type { ProviderExecutionContext } from "@model-runtime/core";

const origin = "https://provider.example.test";
const submission = {
  status_url: `${origin}/status`,
  response_url: `${origin}/result`,
  cancel_url: `${origin}/cancel`,
};
const request = {
  ability: "image-generation",
  input: [{ type: "text" as const, text: "fixture" }],
};

function context(signal = new AbortController().signal): ProviderExecutionContext {
  return {
    executionId: "fixture",
    target: { provider: "fal", model: "model-alpha" },
    request,
    signal,
  };
}

function provider(fetch: typeof globalThis.fetch): FalQueueProvider {
  return new FalQueueProvider({
    apiKey: "fixture-credential",
    model: "model-alpha",
    ability: "image-generation",
    baseUrl: origin,
    maxPolls: 1,
    pollIntervalMs: 1,
    cancelTimeoutMs: 25,
    fetch,
  });
}

describe("fal remote task cleanup", () => {
  it("cancels on polling exhaustion and does not execute a fallback task", async () => {
    const calls: string[] = [];
    const runtime = new ModelRuntime();
    runtime.register(
      provider(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return Response.json(path === "/model-alpha" ? submission : { status: "IN_PROGRESS" });
      }),
    );
    runtime.register(new MockProvider({ id: "provider-second", abilities: ["image-generation"] }));
    const submitted = await runtime.submit({
      ...request,
      routing: { allow_fallback: true, max_attempts: 2 },
    });
    await runtime.waitForIdle();
    expect(await runtime.get(submitted.execution_id)).toMatchObject({
      status: "failed",
      target: { provider: "fal" },
      error: { code: "deadline_exceeded", retryable: false },
    });
    expect(calls).toEqual(["/model-alpha", "/status", "/cancel"]);
  });

  it("deduplicates cancellation and uses a signal independent of the execution", async () => {
    const controller = new AbortController();
    let cancellations = 0;
    const iterator = provider(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === "/cancel") {
        cancellations += 1;
        expect(options?.method).toBe("PUT");
        expect(options?.signal).not.toBe(controller.signal);
        expect(options?.signal?.aborted).toBe(false);
      }
      return Response.json(path === "/model-alpha" ? submission : { status: "IN_QUEUE" });
    })
      .execute(context(controller.signal))
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ phase: "queued" });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(cancellations).toBe(1);
  });

  it("bounds a stalled cancellation request without replacing the original error", async () => {
    let cancelSignal: AbortSignal | null | undefined;
    const iterator = provider(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === "/cancel") {
        cancelSignal = options?.signal;
        return new Promise<Response>((_resolve, reject) => {
          cancelSignal?.addEventListener("abort", () => reject(cancelSignal?.reason), {
            once: true,
          });
        });
      }
      return Response.json(path === "/model-alpha" ? submission : { status: "IN_PROGRESS" });
    })
      .execute(context())
      [Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "deadline_exceeded",
      retryable: false,
    });
    expect(cancelSignal?.aborted).toBe(true);
  });

  it("cleans up when a consumer closes the provider iterator early", async () => {
    let cancellations = 0;
    const iterator = provider(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/cancel") cancellations += 1;
      return Response.json(path === "/model-alpha" ? submission : { status: "IN_QUEUE" });
    })
      .execute(context())
      [Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(cancellations).toBe(1);
  });

  it("does not cancel or retry a completed task when result retrieval fails", async () => {
    const calls: string[] = [];
    const iterator = provider(async (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === "/result") return Response.json({}, { status: 503 });
      return Response.json(path === "/model-alpha" ? submission : { status: "COMPLETED" });
    })
      .execute(context())
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ retryable: false });
    expect(calls).toEqual(["/model-alpha", "/status", "/result"]);
  });

  it("cleans up a valid cancellation URL when another lifecycle URL is malformed", async () => {
    const calls: string[] = [];
    const iterator = provider(async (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return Response.json(path === "/model-alpha" ? { ...submission, status_url: "invalid" } : {});
    })
      .execute(context())
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ retryable: false });
    expect(calls).toEqual(["/model-alpha", "/cancel"]);
  });

  it("does not retry an ambiguous submit transport failure", async () => {
    const iterator = provider(async () => {
      throw new TypeError("Synthetic connection loss");
    })
      .execute(context())
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ retryable: false });
  });

  it("cleans up after a polling HTTP failure even if cancellation is rejected", async () => {
    const calls: string[] = [];
    const iterator = provider(async (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === "/model-alpha") return Response.json(submission);
      return Response.json({}, { status: path === "/cancel" ? 409 : 503 });
    })
      .execute(context())
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: false,
    });
    expect(calls).toEqual(["/model-alpha", "/status", "/cancel"]);
  });

  it("preserves retry classification for explicit submission rejection", async () => {
    const iterator = provider(async () => Response.json({}, { status: 429 }))
      .execute(context())
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ retryable: true });
  });

  it("does not cancel a completed remote task when result retrieval is aborted", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const iterator = provider(async (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === "/result") {
        controller.abort();
        throw new DOMException("Synthetic cancellation", "AbortError");
      }
      return Response.json(path === "/model-alpha" ? submission : { status: "COMPLETED" });
    })
      .execute(context(controller.signal))
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(calls).toEqual(["/model-alpha", "/status", "/result"]);
  });

  it("handles cancellation before the submit response is processed", async () => {
    const controller = new AbortController();
    let cancellations = 0;
    const iterator = provider(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/model-alpha") {
        controller.abort();
        return Response.json(submission);
      }
      if (path === "/cancel") cancellations += 1;
      return Response.json({});
    })
      .execute(context(controller.signal))
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(cancellations).toBe(1);
  });
});
