#!/usr/bin/env node
import { runtimeFromConfig } from "./config.js";
import { createReferenceServer } from "./server.js";

const host = process.env.MODEL_RUNTIME_HOST ?? "127.0.0.1";
const port = Number(process.env.MODEL_RUNTIME_PORT ?? "4320");
const graceMs = Number(process.env.MODEL_RUNTIME_SHUTDOWN_GRACE_MS ?? "10000");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("MODEL_RUNTIME_PORT must be a valid TCP port");
}
if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 60_000) {
  throw new Error("MODEL_RUNTIME_SHUTDOWN_GRACE_MS must be an integer from 1 to 60000");
}

const runtime = await runtimeFromConfig(process.env.MODEL_RUNTIME_CONFIG).catch(() => {
  process.stderr.write(
    "Runtime startup failed. Verify configuration and required environment variables.\n",
  );
  process.exit(1);
});
const server = createReferenceServer(runtime);
let stopping = false;
server.on("request", (_request, response) => {
  // Active keep-alive responses may become idle after server.close() starts.
  response.once("finish", () => {
    if (stopping) server.closeIdleConnections();
  });
});

server.listen(port, host, () => {
  process.stdout.write(`Model Runtime reference server listening on http://${host}:${port}\n`);
  process.stdout.write("Development only: the reference server is unauthenticated.\n");
});

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => {
    server.closeAllConnections();
    process.stderr.write("Runtime shutdown grace period expired.\n");
    process.exit(1);
  }, graceMs);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await runtime.shutdown();
    server.closeIdleConnections();
    await closed;
    await runtime.close();
  } finally {
    clearTimeout(timeout);
  }
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
