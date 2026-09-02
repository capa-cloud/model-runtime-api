import { createServer as createNodeServer, type IncomingMessage, type Server } from "node:http";
import { ModelRuntime, RuntimeError } from "@model-runtime/core";
import type { ExecutionRequest } from "@model-runtime/protocol";

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
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new RuntimeError("invalid_request", "Content-Type must be application/json");
        }
        const body = (await readJson(request)) as ExecutionRequest;
        const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
        if (
          idempotencyKey !== undefined &&
          (idempotencyKey.length < 1 || idempotencyKey.length > 256)
        ) {
          throw new RuntimeError(
            "invalid_request",
            "Idempotency-Key must contain 1 to 256 characters",
          );
        }
        const submission = await runtime.submit(body, idempotencyKey);
        if (request.headers.accept?.includes("text/event-stream")) {
          return streamEvents(response, runtime, submission.execution_id, 0);
        }
        return sendJson(response, submission.idempotent_replay ? 200 : 202, submission);
      }

      const executionMatch = url.pathname.match(/^\/v1\/executions\/([^/]+)$/);
      if (request.method === "GET" && executionMatch?.[1]) {
        const snapshot = await runtime.get(decodeURIComponent(executionMatch[1]));
        return snapshot
          ? sendJson(response, 200, snapshot)
          : sendJson(response, 404, {
              error: { code: "not_found", message: "Execution not found" },
            });
      }

      const eventsMatch = url.pathname.match(/^\/v1\/executions\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch?.[1]) {
        const executionId = decodeURIComponent(eventsMatch[1]);
        if (!(await runtime.get(executionId))) {
          return sendJson(response, 404, {
            error: { code: "not_found", message: "Execution not found" },
          });
        }
        const lastEventId = singleHeader(request.headers["last-event-id"]);
        const after = Number(url.searchParams.get("after") ?? lastEventId ?? "0");
        if (!Number.isSafeInteger(after) || after < 0) {
          throw new RuntimeError("invalid_request", "Event cursor must be a non-negative integer");
        }
        return streamEvents(response, runtime, executionId, after);
      }

      const resultMatch = url.pathname.match(/^\/v1\/executions\/([^/]+)\/result$/);
      if (request.method === "GET" && resultMatch?.[1]) {
        const snapshot = await runtime.get(decodeURIComponent(resultMatch[1]));
        if (!snapshot) {
          return sendJson(response, 404, {
            error: { code: "not_found", message: "Execution not found" },
          });
        }
        if (snapshot.status !== "succeeded") {
          return sendJson(response, 409, { status: snapshot.status, error: snapshot.error });
        }
        return sendJson(response, 200, {
          execution_id: snapshot.execution_id,
          target: snapshot.target,
          result: snapshot.result,
          artifacts: snapshot.artifacts ?? [],
          usage: snapshot.usage,
        });
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

async function streamEvents(
  response: import("node:http").ServerResponse,
  runtime: ModelRuntime,
  executionId: string,
  afterSequence: number,
): Promise<void> {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive",
  });
  for await (const event of runtime.events(executionId, afterSequence, controller.signal)) {
    response.write(`id: ${event.sequence}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
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

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
