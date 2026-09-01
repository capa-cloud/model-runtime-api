import { createServer as createNodeServer, type IncomingMessage, type Server } from "node:http";
import { ModelRuntime, RuntimeError } from "@model-runtime/core";
import type { ExecutionRequest, RuntimeEvent } from "@model-runtime/protocol";

const maximumBodyBytes = 1024 * 1024;

export function createReferenceServer(runtime: ModelRuntime): Server {
  return createNodeServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");
    try {
      const url = new URL(request.url ?? "/", "http://runtime.local");
      if (request.method === "GET" && url.pathname === "/v1/runtime") {
        return sendJson(response, 200, runtime.info());
      }
      if (request.method === "GET" && url.pathname === "/v1/providers") {
        return sendJson(response, 200, { data: await runtime.manifests() });
      }
      if (request.method === "POST" && url.pathname === "/v1/executions") {
        const body = (await readJson(request)) as ExecutionRequest;
        if (request.headers.accept?.includes("text/event-stream")) {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            connection: "keep-alive",
          });
          for await (const event of runtime.execute(body)) {
            response.write(`id: ${event.sequence}\n`);
            response.write(`event: ${event.type}\n`);
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end();
          return;
        }
        const events: RuntimeEvent[] = [];
        for await (const event of runtime.execute(body)) events.push(event);
        return sendJson(response, 200, { events });
      }

      const cancelMatch = url.pathname.match(/^\/v1\/executions\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch?.[1]) {
        const cancelled = runtime.cancel(decodeURIComponent(cancelMatch[1]));
        return sendJson(response, cancelled ? 202 : 404, {
          status: cancelled ? "cancellation_requested" : "not_found",
        });
      }
      return sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const runtimeError =
        error instanceof RuntimeError
          ? error
          : new RuntimeError("invalid_request", "Request could not be processed", { cause: error });
      return sendJson(response, runtimeError.code === "invalid_request" ? 400 : 500, {
        error: runtimeError.toShape(),
      });
    }
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBodyBytes) {
      throw new RuntimeError("invalid_request", "Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new RuntimeError("invalid_request", "Request body must be valid JSON", { cause: error });
  }
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
