import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicMessagesProvider } from "@model-runtime/provider-anthropic";
import { OpenAiResponsesProvider } from "@model-runtime/provider-openai";
import { FalQueueProvider } from "@model-runtime/provider-fal";
import type { ProviderExecutionContext, ModelProvider } from "@model-runtime/core";
import { assertSafeBaseUrl } from "@model-runtime/core";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function context(ability = "text-generation"): ProviderExecutionContext {
  return {
    executionId: "fixture",
    request: { ability, input: [{ type: "text", text: "fixture" }] },
    target: { provider: "provider-a", model: "model-alpha" },
    signal: new AbortController().signal,
  };
}

async function drain(provider: ModelProvider, ability?: string): Promise<void> {
  for await (const _event of provider.execute(context(ability))) {
    /* consume the fixture */
  }
}

describe("provider outbound trust boundary", () => {
  it.each(["openai", "anthropic", "fal"])(
    "does not follow a %s submission redirect",
    async (kind) => {
      let foreignRequests = 0;
      const foreign = await listen(
        createServer((_request, response) => {
          foreignRequests += 1;
          response.writeHead(200).end("fixture");
        }),
      );
      const baseUrl = await listen(
        createServer((_request, response) => {
          response.writeHead(307, { location: `${foreign}/destination` }).end();
        }),
      );
      const options = { apiKey: "fixture-credential", model: "model-alpha", baseUrl };
      const provider =
        kind === "anthropic"
          ? new AnthropicMessagesProvider(options)
          : kind === "openai"
            ? new OpenAiResponsesProvider(options)
            : new FalQueueProvider({ ...options, ability: "image-generation" });
      await expect(
        drain(provider, kind === "fal" ? "image-generation" : undefined),
      ).rejects.toThrow();
      expect(foreignRequests).toBe(0);
    },
  );

  it.each(["status", "result", "cancel"])(
    "does not follow a fal %s redirect",
    async (operation) => {
      let foreignRequests = 0;
      const foreign = await listen(
        createServer((_request, response) => {
          foreignRequests += 1;
          response.writeHead(200).end("{}");
        }),
      );
      let baseUrl = "";
      baseUrl = await listen(
        createServer((request, response) => {
          if (request.url === `/${operation}`) {
            response.writeHead(307, { location: `${foreign}/destination` }).end();
          } else {
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify(
                request.url === "/model-alpha"
                  ? {
                      status_url: `${baseUrl}/status`,
                      response_url: `${baseUrl}/result`,
                      cancel_url: `${baseUrl}/cancel`,
                    }
                  : { status: operation === "result" ? "COMPLETED" : "IN_PROGRESS" },
              ),
            );
          }
        }),
      );
      const provider = new FalQueueProvider({
        apiKey: "fixture-credential",
        model: "model-alpha",
        ability: "image-generation",
        baseUrl,
        maxPolls: 1,
        pollIntervalMs: 1,
      });
      await expect(drain(provider, "image-generation")).rejects.toThrow();
      expect(foreignRequests).toBe(0);
    },
  );

  it("rejects model identifiers that switch the fal submission origin before any fetch", async () => {
    let fetched = false;
    const provider = new FalQueueProvider({
      apiKey: "fixture-credential",
      model: "https://other.example.test/model",
      ability: "image-generation",
      fetch: async () => {
        fetched = true;
        return Response.json({});
      },
    });
    await expect(drain(provider, "image-generation")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetched).toBe(false);
  });

  it("allows IPv6 loopback but rejects credential/query-bearing base URLs", () => {
    expect(assertSafeBaseUrl("http://[::1]:4320").hostname).toBe("[::1]");
    expect(() => assertSafeBaseUrl("https://provider.example.test?credential=fixture")).toThrow();
    expect(() => assertSafeBaseUrl("https://user:password@example.test")).toThrow();
  });
});
