import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "@model-runtime/core";
import { AnthropicMessagesProvider } from "@model-runtime/provider-anthropic";
import { FalQueueProvider } from "@model-runtime/provider-fal";
import { OpenAiResponsesProvider } from "@model-runtime/provider-openai";
import type { RuntimeEvent } from "@model-runtime/protocol";

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

describe("public provider adapters", () => {
  it("maps OpenAI Responses text, tool and usage SSE events", async () => {
    const fixture = await startFixture(async (request, response) => {
      expect(request.url).toBe("/v1/responses");
      const body = await readJson(request);
      expect(body).toMatchObject({ model: "model-public", stream: true, store: false });
      writeSse(response, [
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup" },
        },
        { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '{"key":' },
        { type: "response.output_text.delta", output_index: 0, delta: "hello" },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 1 },
              output_tokens_details: { reasoning_tokens: 1 },
            },
          },
        },
      ]);
    });
    const runtime = new ModelRuntime();
    runtime.register(
      new OpenAiResponsesProvider({
        apiKey: "fixture-credential",
        capabilities: { tools: true },
        model: "model-public",
        baseUrl: `${fixture}/v1`,
      }),
    );
    const events = await collect(
      runtime.execute({
        ability: "text-generation",
        input: [{ type: "text", text: "fixture" }],
        requirements: { stream: true, tools: true },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.call.started", call_id: "call-1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.call.arguments.delta", call_id: "call-1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "output.delta", delta: "hello" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage.reported",
        facts: expect.arrayContaining([
          expect.objectContaining({ unit: "reasoning_token", quantity: 1 }),
        ]),
      }),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
  });

  it("maps Anthropic content blocks, partial tool JSON and usage", async () => {
    const fixture = await startFixture(async (request, response) => {
      expect(request.url).toBe("/v1/messages");
      expect(await readJson(request)).toMatchObject({ model: "model-public", stream: true });
      writeSse(response, [
        {
          type: "message_start",
          message: { usage: { input_tokens: 4, cache_read_input_tokens: 2 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-1", name: "lookup" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"key":' },
        },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
        { type: "message_delta", usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]);
    });
    const runtime = new ModelRuntime();
    runtime.register(
      new AnthropicMessagesProvider({
        apiKey: "fixture-credential",
        capabilities: { tools: true },
        model: "model-public",
        baseUrl: fixture,
      }),
    );
    const events = await collect(
      runtime.execute({
        ability: "text-generation",
        input: [{ type: "text", text: "fixture" }],
        requirements: { stream: true, tools: true },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.call.started", call_id: "tool-1" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "output.delta", delta: "hello" }),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
  });

  it("maps the fal queue lifecycle and returns artifacts without fetching them", async () => {
    let statusCalls = 0;
    let fixture = "";
    fixture = await startFixture(async (request, response) => {
      if (request.method === "POST" && request.url === "/models/image") {
        await readJson(request);
        return sendJson(response, {
          request_id: "request-public",
          status_url: `${fixture}/status`,
          response_url: `${fixture}/result`,
          cancel_url: `${fixture}/cancel`,
        });
      }
      if (request.url === "/status") {
        statusCalls += 1;
        return sendJson(response, { status: statusCalls === 1 ? "IN_QUEUE" : "COMPLETED" });
      }
      if (request.url === "/result") {
        return sendJson(response, {
          images: [{ url: "https://media.example.test/result.png", content_type: "image/png" }],
        });
      }
      response.writeHead(404).end();
    });
    const runtime = new ModelRuntime();
    runtime.register(
      new FalQueueProvider({
        apiKey: "fixture-credential",
        model: "models/image",
        ability: "image-generation",
        baseUrl: fixture,
        pollIntervalMs: 1,
      }),
    );
    const events = await collect(
      runtime.execute({
        ability: "image-generation",
        input: [{ type: "text", text: "fixture" }],
        requirements: { async: true },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "execution.progress", phase: "queued" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "output.result",
        artifacts: [{ uri: "https://media.example.test/result.png", media_type: "image/png" }],
      }),
    );
    expect(events.at(-1)?.type).toBe("execution.completed");
  });
});

async function startFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      response.writeHead(500).end(error instanceof Error ? error.message : "fixture failure");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeSse(response: ServerResponse, events: Record<string, unknown>[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
