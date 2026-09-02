import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@model-runtime/core";
import { MockProvider } from "@model-runtime/provider-mock";
import { ModelRuntimeClient } from "@model-runtime/sdk-typescript";
import { createReferenceServer } from "@model-runtime/server";

const servers: import("node:http").Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("reference server and TypeScript SDK", () => {
  it("rejects runtime URLs containing credentials", () => {
    expect(() => new ModelRuntimeClient({ baseUrl: "https://user:password@example.test" })).toThrow(
      "without credentials",
    );
  });

  it("streams one complete execution over SSE", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());
    const server = createReferenceServer(runtime);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = new ModelRuntimeClient({ baseUrl: `http://127.0.0.1:${address.port}` });

    expect(await client.info()).toMatchObject({ provider_count: 1, features: { billing: false } });

    const events = [];
    for await (const event of client.execute({
      ability: "text-generation",
      requirements: { stream: true },
      input: [{ type: "text", text: "test fixture" }],
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({ type: "execution.accepted", sequence: 1 });
    expect(events.at(-1)).toMatchObject({ type: "execution.completed" });
    const executionId = events[0]?.execution_id ?? "missing";
    expect(await client.get(executionId)).toMatchObject({ status: "succeeded", last_sequence: 7 });
    expect(await client.result(executionId)).toMatchObject({
      execution_id: executionId,
      result: { outputs: [{ index: 0, type: "text", text: "hello from mock" }] },
      usage: expect.any(Array),
    });
  });

  it("returns the same execution for the same idempotency key", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());
    const server = createReferenceServer(runtime);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = new ModelRuntimeClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const request = {
      ability: "text-generation",
      input: [{ type: "text" as const, text: "test fixture" }],
    };
    const first = await client.submit(request, "request-1");
    const replay = await client.submit(request, "request-1");
    expect(replay).toMatchObject({ execution_id: first.execution_id, idempotent_replay: true });
  });

  it("rejects a non-JSON execution request", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());
    const server = createReferenceServer(runtime);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/executions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json",
    });
    expect(response.status).toBe(400);
  });
});
