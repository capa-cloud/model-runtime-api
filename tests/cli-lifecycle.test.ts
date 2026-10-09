import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createPortReservation } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const children: { child: ChildProcessWithoutNullStreams; exited: Promise<number | null> }[] = [];
const upstreams: import("node:http").Server[] = [];

afterEach(async () => {
  for (const running of children.splice(0)) {
    if (running.child.exitCode === null && running.child.signalCode === null)
      running.child.kill("SIGKILL");
    await running.exited;
  }
  await Promise.all(
    upstreams.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function configFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "model-runtime-fixture-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, content);
  return path;
}

async function launch(options: { config?: string; grace?: number; expectReady?: boolean } = {}) {
  const reservation = createPortReservation();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["packages/server/dist/cli.js"], {
    env: {
      MODEL_RUNTIME_HOST: "127.0.0.1",
      MODEL_RUNTIME_PORT: String(port),
      MODEL_RUNTIME_SHUTDOWN_GRACE_MS: String(options.grace ?? 1000),
      ...(options.config ? { MODEL_RUNTIME_CONFIG: options.config } : {}),
      PROVIDER_A_API_KEY: "fixture-credential",
    },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4096);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  children.push({ child, exited });
  if (options.expectReady !== false) {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("reference server listening")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Fixture CLI exited before startup")));
    });
  }
  return { child, exited, stderr: () => stderr, base: `http://127.0.0.1:${port}` };
}

async function within<T>(operation: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture timed out during ${phase}`)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("CLI process lifecycle", () => {
  it("cancels a live provider stream and exits cleanly on SIGTERM", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data:{"type":"response.output_text.delta","output_index":0,"delta":"fixture"}\n\n',
      );
    });
    upstreams.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    const config = await configFile(
      JSON.stringify({
        providers: [
          {
            type: "openai-responses",
            model: "model-alpha",
            api_key_env: "PROVIDER_A_API_KEY",
            base_url: baseUrl,
          },
        ],
      }),
    );
    const running = await launch({ config });
    const submitted = await fetch(`${running.base}/v1/executions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ability: "text-generation",
        input: [{ type: "text", text: "fixture" }],
      }),
    });
    const { execution_id: id } = await submitted.json();
    const stream = await fetch(`${running.base}/v1/executions/${id}/events`);
    const reader = stream.body!.getReader();
    let events = "";
    await within(
      (async () => {
        while (!events.includes('"type":"output.delta"')) {
          const next = await reader.read();
          if (next.done) throw new Error("Fixture stream ended too soon");
          events += new TextDecoder().decode(next.value);
        }
      })(),
      "provider output",
    );
    running.child.kill("SIGTERM");
    await within(
      (async () => {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          events += new TextDecoder().decode(next.value);
        }
      })(),
      "subscriber closure",
    );
    reader.releaseLock();
    expect(events).toContain('"status":"cancelled"');
    expect(await within(running.exited, "CLI exit")).toBe(0);
  });

  it("bounds shutdown when an HTTP request never finishes its body", async () => {
    const running = await launch({ grace: 100 });
    const pending = httpRequest(`${running.base}/v1/executions`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1000" },
    });
    pending.on("error", () => undefined);
    pending.write("{");
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect((await fetch(`${running.base}/v1/runtime`)).status).toBe(200);
    running.child.kill("SIGTERM");
    expect(await running.exited).toBe(1);
    expect(running.stderr()).toContain("grace period expired");
    pending.destroy();
  });

  it("does not print configuration content when startup parsing fails", async () => {
    const config = await configFile('{"fixture":"fixture-sensitive-content",');
    const running = await launch({ config, expectReady: false });
    expect(await running.exited).toBe(1);
    expect(running.stderr()).toContain("Runtime startup failed");
    expect(running.stderr()).not.toContain("fixture-sensitive-content");
  });
});
