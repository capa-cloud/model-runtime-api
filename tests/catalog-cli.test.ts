import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCatalogSnapshot,
  createDiscoverySnapshot,
  discoverModels,
} from "@model-runtime/catalog";
import { MockProvider } from "@model-runtime/provider-mock";

const execute = promisify(execFile);
const directories: string[] = [];
const servers: Server[] = [];
const cli = resolve("packages/catalog/dist/cli.js");
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
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
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }
}
async function file(name: string, content: string) {
  const directory = await mkdtemp(join(tmpdir(), "catalog-cli-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, content, { mode: 0o600 });
  return path;
}
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("catalog CLI and network boundary", () => {
  it("snapshots a real loopback runtime provider endpoint", async () => {
    const manifest = await new MockProvider().manifest();
    const base = await serve((request, response) => {
      if (request.url !== "/v1/providers") {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [manifest] }));
    });
    const result = await run(["snapshot", base]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).providers[0].provider).toBe("provider-mock");
    expect(result.stderr).toBe("");
  });

  it("runs offline radar baseline/comparison and validated catalog diff", async () => {
    const source = { provider: "openai" as const, scope: "account-a" };
    const before = await file(
      "before.json",
      JSON.stringify(
        createDiscoverySnapshot(source, [{ id: "model-alpha" }], "2026-10-09T00:00:00Z"),
      ),
    );
    const after = await file(
      "after.json",
      JSON.stringify(
        createDiscoverySnapshot(
          source,
          [{ id: "model-alpha" }, { id: "model-beta" }],
          "2026-10-09T01:00:00Z",
        ),
      ),
    );
    const baseline = await run(["radar", before]);
    expect(baseline.code).toBe(0);
    expect(JSON.parse(baseline.stdout).status).toBe("baseline");
    const shortcut = await execute("pnpm", ["--silent", "catalog", "radar", before], {
      env: { PATH: process.env.PATH },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    expect(JSON.parse(shortcut.stdout).status).toBe("baseline");
    expect(shortcut.stderr).toBe("");
    const compared = await run(["radar", before, after]);
    expect(compared.code).toBe(0);
    expect(JSON.parse(compared.stdout).added_models).toEqual(["model-beta"]);
    const catalog = await file(
      "catalog.json",
      JSON.stringify(createCatalogSnapshot([await new MockProvider().manifest()])),
    );
    const diff = await run(["diff", catalog, catalog]);
    expect(diff.code).toBe(0);
    expect(JSON.parse(diff.stdout)).toEqual({
      added_models: [],
      removed_models: [],
      changed_models: [],
    });
  });

  it("does not emit raw failed response bodies or malformed local content", async () => {
    const base = await serve((_request, response) => {
      response.writeHead(503).end("synthetic-private-error");
    });
    for (const args of [
      ["snapshot", base],
      ["radar", await file("bad.json", "synthetic-private-error")],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("no verified result");
      expect(result.stderr).not.toMatch(/synthetic-private-error|catalog-cli-|Error:|at /);
    }
  });

  it("rejects oversized files and missing credentials without producing a snapshot", async () => {
    const large = await file("large.json", "x".repeat(4 * 1024 * 1024 + 1));
    for (const args of [
      ["radar", large],
      ["discover", "openai", "MISSING_FIXTURE_CREDENTIAL", "account-a"],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }
    expect((await run(["discover", "openai", "fixture-credential", "account-a"])).code).toBe(2);
    expect((await run(["diff", "before", "after", "unexpected"])).code).toBe(2);
  });

  it("does not follow model-list redirects with credentials", async () => {
    const paths: string[] = [];
    const base = await serve((request, response) => {
      paths.push(request.url!);
      response.writeHead(302, { location: "/credential-leak-fixture" }).end();
    });
    await expect(
      discoverModels({
        provider: "openai",
        scope: "account-a",
        baseUrl: `${base}/v1`,
        apiKey: "fixture-credential",
      }),
    ).rejects.toThrow("no complete snapshot");
    expect(paths).toEqual(["/v1/models"]);
  });
});
