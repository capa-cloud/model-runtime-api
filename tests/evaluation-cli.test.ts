import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cli = resolve("packages/evaluation/dist/cli.js");
const example = resolve("deploy/evaluation-suite.example.json");
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function file(name: string, value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-evaluation-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
async function run(args: string[]) {
  try {
    const result = await execute(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return result;
  }
}

describe("evaluation CLI", () => {
  it("runs the documented fixture and produces valid JSON through the pnpm shortcut", async () => {
    const result = await execute(
      "pnpm",
      ["--silent", "evaluate", "run", "fixture", example, "fixture-context"],
      { env: { PATH: process.env.PATH }, timeout: 5000 },
    );
    const report = JSON.parse(result.stdout);
    expect(report.complete).toBe(true);
    expect(report.evidence_kind).toBe("fixture");
    expect(report.cases).toHaveLength(10);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/hello from mock|synthetic fixture|input_token/);
  });
  it("recommends from fixture evidence explicitly and refuses to use it as live evidence", async () => {
    const report = JSON.parse((await run(["run", "fixture", example, "fixture-context"])).stdout);
    const path = await file("report.json", report);
    const catalog = await file(
      "catalog.json",
      JSON.parse((await run(["catalog", "fixture"])).stdout),
    );
    const fixture = await run([
      "recommend",
      "fixture",
      example,
      catalog,
      "fixture-context",
      "pass_rate",
      path,
    ]);
    expect(fixture.code).toBe(0);
    expect(JSON.parse(fixture.stdout).scenarios[0].recommended_models).toHaveLength(1);
    const live = await run([
      "recommend",
      "live",
      example,
      catalog,
      "fixture-context",
      "pass_rate",
      path,
    ]);
    expect(live.code).toBe(0);
    expect(JSON.parse(live.stdout).scenarios[0].status).toBe("insufficient_evidence");
  });
  it("returns nonzero for failed assertions while retaining a sanitized report", async () => {
    const value = JSON.parse(await readFile(example, "utf8"));
    value.cases[0].checks[0].value = "synthetic-private-expectation";
    const result = await run([
      "run",
      "fixture",
      await file("suite.json", value),
      "fixture-context",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).complete).toBe(true);
    expect(JSON.parse(result.stdout).cases[0].status).toBe("assertion_failed");
    expect(result.stdout).not.toContain("synthetic-private-expectation");
  });
  it.each([
    {
      name: "inline credentials",
      config: {
        providers: [
          { type: "openai-responses", model: "model-alpha", api_key: "synthetic-private-value" },
        ],
      },
    },
    { name: "mock in live mode", config: { providers: [{ type: "mock" }] } },
    {
      name: "persistent storage",
      config: {
        providers: [
          {
            type: "openai-responses",
            model: "model-alpha",
            api_key_env: "MISSING_EVAL_CREDENTIAL",
          },
        ],
        event_store: { type: "memory" },
      },
    },
    {
      name: "multiple providers",
      config: { providers: [{ type: "mock" }, { type: "mock", id: "provider-b" }] },
    },
  ])("rejects $name without diagnostics leaking", async ({ config }) => {
    const result = await run([
      "run",
      "live",
      example,
      await file("config.json", config),
      "fixture-context",
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/synthetic-private-value|runtime-evaluation-|at /);
  });
  it("rejects extra fixture arguments", async () => {
    expect((await run(["run", "fixture", example, "fixture-context", "unexpected"])).code).toBe(2);
  });
  it("records missing live credentials as a failed execution without calling a public endpoint", async () => {
    const config = await file("config.json", {
      providers: [
        { type: "openai-responses", model: "model-alpha", api_key_env: "MISSING_EVAL_CREDENTIAL" },
      ],
    });
    const result = await run(["run", "live", example, config, "fixture-context"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.metrics[0].completed_count).toBe(0);
    expect(report.cases[0].status).toBe("execution_failed");
    expect(result.stdout).not.toContain("MISSING_EVAL_CREDENTIAL");
  });
  it("contains and cancels a live-mode CLI stream on SIGTERM using only a loopback fixture", async () => {
    let start!: () => void;
    const ready = new Promise<void>((resolve) => {
      start = resolve;
    });
    let disconnected = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"type":"response.output_text.delta","delta":"synthetic-private-output"}\n\n',
      );
      response.once("close", () => {
        disconnected = true;
      });
      start();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config = await file("config.json", {
      providers: [
        {
          type: "openai-responses",
          model: "model-alpha",
          api_key_env: "PROVIDER_FIXTURE_API_KEY",
          base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        },
      ],
    });
    const child = spawn(
      process.execPath,
      [cli, "run", "live", example, config, "fixture-context"],
      {
        env: { PATH: process.env.PATH, PROVIDER_FIXTURE_API_KEY: "fixture-credential" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    const closed = once(child, "close");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        closed.then(() => {
          throw new Error("Fixture child exited before request");
        }),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Fixture child did not start")), 3000);
        }),
      ]);
      child.kill("SIGTERM");
      const [code] = await closed;
      expect(code).toBe(1);
      expect(JSON.parse(stdout).complete).toBe(false);
      expect(disconnected).toBe(true);
      expect(stdout + stderr).not.toMatch(/synthetic-private-output|fixture-credential/);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
  });
});
