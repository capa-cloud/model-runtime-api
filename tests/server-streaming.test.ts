import { get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEventStore, ModelRuntime } from "@model-runtime/core";
import type { RuntimeEvent } from "@model-runtime/protocol";
import { createReferenceServer } from "@model-runtime/server";

const servers: import("node:http").Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

const accepted: RuntimeEvent = {
  type: "execution.accepted",
  execution_id: "fixture",
  sequence: 1,
  time: "2026-10-09T00:00:00.000Z",
  status: "accepted",
};

async function serve(store: InMemoryEventStore): Promise<string> {
  await store.create("fixture", accepted.time);
  await store.append(accepted);
  const server = createReferenceServer(new ModelRuntime({ eventStore: store }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("reference server streaming lifecycle", () => {
  it("contains a failing EventStore stream and remains available", async () => {
    class FailingStore extends InMemoryEventStore {
      override async *watch(): AsyncGenerator<RuntimeEvent> {
        yield accepted;
        throw new Error("Synthetic EventStore failure");
      }
    }
    const base = await serve(new FailingStore());
    await expect(
      fetch(`${base}/v1/executions/fixture/events`).then((response) => response.text()),
    ).rejects.toThrow();
    expect((await fetch(`${base}/v1/runtime`)).status).toBe(200);
  });

  it("stops draining events into a paused client and cleans up after disconnect", async () => {
    let produced = 0;
    let cleaned = false;
    class FastStore extends InMemoryEventStore {
      override async *watch(
        _executionId: string,
        _after = 0,
        signal?: AbortSignal,
      ): AsyncGenerator<RuntimeEvent> {
        try {
          for (let index = 0; index < 200 && !signal?.aborted; index += 1) {
            produced += 1;
            yield {
              ...accepted,
              type: "output.delta",
              status: "running",
              sequence: index + 1,
              output_index: 0,
              delta: "x".repeat(128 * 1024),
            };
          }
        } finally {
          cleaned = true;
        }
      }
    }
    const base = await serve(new FastStore());
    await new Promise<void>((resolve, reject) => {
      const request = httpGet(`${base}/v1/executions/fixture/events`, (response) => {
        response.pause();
        setTimeout(() => {
          try {
            expect(produced).toBeGreaterThan(0);
            expect(produced).toBeLessThan(200);
          } catch (error) {
            reject(error);
          } finally {
            response.destroy();
            request.destroy();
            resolve();
          }
        }, 80);
      });
      request.on("error", reject);
    });
    await expect.poll(() => cleaned).toBe(true);
  });
});
