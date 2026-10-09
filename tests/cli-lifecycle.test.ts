import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createPortReservation } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
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

async function launch(
  options: { config?: string; grace?: number; expectReady?: boolean; storeKey?: string } = {},
) {
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
      ...(options.storeKey ? { MODEL_RUNTIME_EVENT_STORE_KEY: options.storeKey } : {}),
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

  it("restarts with durable result, event replay and the same idempotency identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-runtime-persistent-fixture-"));
    directories.push(directory);
    const config = await configFile(
      JSON.stringify({
        providers: [{ type: "mock" }],
        event_store: {
          type: "file",
          directory: join(directory, "events"),
          encryption_key_env: "MODEL_RUNTIME_EVENT_STORE_KEY",
        },
      }),
    );
    const options = { config, storeKey: Buffer.alloc(32, 7).toString("base64") };
    const first = await launch(options);
    const submit = async (base: string) => {
      const response = await fetch(`${base}/v1/executions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "fixture-restart" },
        body: JSON.stringify({
          ability: "text-generation",
          input: [{ type: "text", text: "fixture" }],
        }),
      });
      return { status: response.status, value: await response.json() };
    };
    const created = await submit(first.base);
    const id = created.value.execution_id;
    const events = await fetch(`${first.base}/v1/executions/${id}/events`);
    expect(await events.text()).toContain('"type":"execution.completed"');
    first.child.kill("SIGTERM");
    expect(await within(first.exited, "first durable CLI exit")).toBe(0);
    const second = await launch(options);
    const replay = await submit(second.base);
    expect(replay.status).toBe(200);
    expect(replay.value).toMatchObject({
      execution_id: id,
      idempotent_replay: true,
      status: "succeeded",
    });
    const result = await (await fetch(`${second.base}/v1/executions/${id}/result`)).json();
    expect(result.result.outputs[0].text).toBe("hello from mock");
    const resumed = await fetch(`${second.base}/v1/executions/${id}/events?after=4`);
    expect(await resumed.text()).toContain("id: 5");
    second.child.kill("SIGTERM");
    expect(await within(second.exited, "second durable CLI exit")).toBe(0);
  });

  it("recovers a SIGKILL interruption after the owned writer lease expires without resubmitting", async () => {
    let calls = 0;
    const upstream = createServer((request, response) => {
      calls += 1;
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data:{"type":"response.output_text.delta","output_index":0,"delta":"partial"}\n\n',
      );
    });
    upstreams.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const directory = await mkdtemp(join(tmpdir(), "runtime-crash-fixture-"));
    directories.push(directory);
    const dataPath = join(directory, "events");
    const config = await configFile(
      JSON.stringify({
        providers: [
          {
            type: "openai-responses",
            model: "model-alpha",
            api_key_env: "PROVIDER_A_API_KEY",
            base_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
          },
        ],
        event_store: {
          type: "file",
          directory: dataPath,
          encryption_key_env: "MODEL_RUNTIME_EVENT_STORE_KEY",
        },
      }),
    );
    const options = { config, storeKey: Buffer.alloc(32, 7).toString("base64") };
    const first = await launch(options);
    const body = JSON.stringify({
      ability: "text-generation",
      input: [{ type: "text", text: "fixture" }],
    });
    const submit = async (base: string) =>
      (
        await fetch(`${base}/v1/executions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "fixture-crash" },
          body,
        })
      ).json();
    const created = await submit(first.base);
    const stream = await fetch(`${first.base}/v1/executions/${created.execution_id}/events`);
    const reader = stream.body!.getReader();
    let events = "";
    await within(
      (async () => {
        while (!events.includes('"type":"output.delta"')) {
          const value = await reader.read();
          if (value.done) throw new Error("Missing fixture output");
          events += new TextDecoder().decode(value.value);
        }
      })(),
      "durable partial output",
    );
    first.child.kill("SIGKILL");
    await within(first.exited, "crashed CLI exit");
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    // Advance only this dead fixture writer's lease clock; no live process owns the lock now.
    const expired = new Date(Date.now() - 60000);
    await utimes(dataPath + ".lock", expired, expired);
    const second = await launch(options);
    const replay = await submit(second.base);
    expect(replay).toMatchObject({
      execution_id: created.execution_id,
      idempotent_replay: true,
      status: "failed",
    });
    const snapshot = await (
      await fetch(`${second.base}/v1/executions/${created.execution_id}`)
    ).json();
    expect(snapshot.error).toMatchObject({ code: "internal_error", retryable: false });
    expect(calls).toBe(1);
    second.child.kill("SIGTERM");
    expect(await within(second.exited, "recovered CLI exit")).toBe(0);
  });
});
