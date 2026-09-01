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
  });
});
