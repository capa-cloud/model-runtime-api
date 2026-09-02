#!/usr/bin/env node
import { runtimeFromConfig } from "./config.js";
import { createReferenceServer } from "./server.js";

const host = process.env.MODEL_RUNTIME_HOST ?? "127.0.0.1";
const port = Number(process.env.MODEL_RUNTIME_PORT ?? "4320");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("MODEL_RUNTIME_PORT must be a valid TCP port");
}

const runtime = await runtimeFromConfig(process.env.MODEL_RUNTIME_CONFIG);
const server = createReferenceServer(runtime);

server.listen(port, host, () => {
  process.stdout.write(`Model Runtime reference server listening on http://${host}:${port}\n`);
  process.stdout.write("Development only: the reference server is unauthenticated.\n");
});

const shutdown = () => {
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
