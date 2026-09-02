import { describe, expect, it } from "vitest";
import { ConcurrencyGate } from "@model-runtime/core";

describe("provider flow control", () => {
  it("queues one waiter and releases it in order", async () => {
    const gate = new ConcurrencyGate(1, 1);
    const releaseFirst = await gate.acquire();
    const second = gate.acquire();
    expect(gate.active).toBe(1);
    expect(gate.queued).toBe(1);
    releaseFirst();
    const releaseSecond = await second;
    expect(gate.active).toBe(1);
    expect(gate.queued).toBe(0);
    releaseSecond();
    expect(gate.active).toBe(0);
  });

  it("rejects above the bounded queue depth", async () => {
    const gate = new ConcurrencyGate(1, 0);
    const release = await gate.acquire();
    await expect(gate.acquire()).rejects.toMatchObject({ code: "queue_full", retryable: true });
    release();
  });

  it("removes a cancelled waiter", async () => {
    const gate = new ConcurrencyGate(1, 1);
    const release = await gate.acquire();
    const controller = new AbortController();
    const waiter = gate.acquire(controller.signal);
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ code: "cancelled" });
    expect(gate.queued).toBe(0);
    release();
  });
});
