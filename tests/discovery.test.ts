import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDiscoverySnapshot,
  discoverModels,
  discoveryRadar,
  parseDiscoverySnapshot,
  pollDiscovery,
} from "@model-runtime/catalog";

const directories: string[] = [];
const source = { provider: "openai" as const, scope: "account-a" };
const observedAt = "2026-10-09T00:00:00Z";
const baseOptions = { ...source, apiKey: "fixture-credential", observedAt };
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function openai(ids = ["model-alpha"]) {
  return {
    object: "list",
    data: ids.map((id) => ({
      object: "model",
      id,
      created: 0,
      owned_by: "synthetic-private-owner",
    })),
  };
}
function anthropic(ids: string[], has_more = false) {
  return {
    data: ids.map((id) => ({
      type: "model",
      id,
      created_at: observedAt,
      display_name: "Synthetic private display",
    })),
    has_more,
    last_id: ids.at(-1) ?? null,
  };
}
const json = (value: unknown) => new Response(JSON.stringify(value));
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "runtime-radar-"));
  directories.push(path);
  return path;
}

describe("account-visible model discovery", () => {
  it("uses the official models endpoint and drops nonessential account fields", async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      json(openai(["model-beta", "model-alpha"])),
    );
    const snapshot = await discoverModels({ ...baseOptions, fetch });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/models");
    expect(snapshot.models.map((model) => model.id)).toEqual(["model-alpha", "model-beta"]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /fixture-credential|owned_by|synthetic-private-owner|api.openai.com/,
    );
    expect(snapshot.models[0]?.vendor_created_at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("fetches every Anthropic page with a bounded cursor and no redirects", async () => {
    const urls: URL[] = [];
    const headers: RequestInit[] = [];
    const fetch = vi.fn(async (value: unknown, init?: RequestInit) => {
      urls.push(new URL(String(value)));
      headers.push(init!);
      return json(urls.length === 1 ? anthropic(["model-beta"], true) : anthropic(["model-alpha"]));
    });
    const snapshot = await discoverModels({ ...baseOptions, provider: "anthropic", fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(urls[0]?.pathname).toBe("/v1/models");
    expect(urls[1]?.searchParams.get("after_id")).toBe("model-beta");
    expect(headers[0]).toMatchObject({
      redirect: "error",
      headers: { "x-api-key": "fixture-credential", "anthropic-version": "2023-06-01" },
    });
    expect(snapshot.models.map((model) => model.id)).toEqual(["model-alpha", "model-beta"]);
    expect(JSON.stringify(snapshot)).not.toContain("display_name");
  });

  it("rejects malformed, duplicate and incomplete inventories", async () => {
    for (const body of [
      null,
      {},
      { data: [] },
      openai(["model-alpha", "model-alpha"]),
      { object: "list", data: [{ object: "model", id: "bad\nmodel", created: 0 }] },
      { object: "list", data: [{ object: "model", id: "model-alpha", created: -1 }] },
    ]) {
      await expect(
        discoverModels({ ...baseOptions, fetch: async () => json(body) }),
      ).rejects.toThrow("no complete snapshot");
    }
    for (const body of [
      { ...anthropic(["model-alpha"], true), last_id: "wrong" },
      anthropic([], true),
      { data: [] },
      { ...anthropic(["model-alpha"]), has_more: "false" },
    ]) {
      await expect(
        discoverModels({ ...baseOptions, provider: "anthropic", fetch: async () => json(body) }),
      ).rejects.toThrow("no complete snapshot");
    }
    await expect(
      discoverModels({
        ...baseOptions,
        provider: "anthropic",
        maxPages: 1,
        fetch: async () => json(anthropic(["model-alpha"], true)),
      }),
    ).rejects.toThrow("no complete snapshot");
  });

  it("rejects repeated models across pages and second-page failures", async () => {
    await expect(
      discoverModels({
        ...baseOptions,
        provider: "anthropic",
        fetch: async () => json(anthropic(["model-alpha"], true)),
      }),
    ).rejects.toThrow("no complete snapshot");
    let calls = 0;
    await expect(
      discoverModels({
        ...baseOptions,
        provider: "anthropic",
        fetch: async () =>
          ++calls === 1
            ? json(anthropic(["model-alpha"], true))
            : new Response("synthetic-private-error", { status: 503 }),
      }),
    ).rejects.toThrow("no complete snapshot");
  });

  it("contains rejected bodies, resolver errors and oversized responses", async () => {
    const cancel = vi.fn();
    const rejected = new Response(new ReadableStream({ cancel }), { status: 403 });
    await expect(discoverModels({ ...baseOptions, fetch: async () => rejected })).rejects.toThrow(
      "Model discovery failed",
    );
    expect(cancel).toHaveBeenCalledOnce();
    await expect(
      discoverModels({
        ...baseOptions,
        apiKey: () => {
          throw new Error("synthetic-private-error");
        },
      }),
    ).rejects.toThrow(/^Model discovery failed; no complete snapshot was produced$/);
    await expect(
      discoverModels({
        ...baseOptions,
        fetch: async () => new Response("x".repeat(1024 * 1024 + 1)),
      }),
    ).rejects.toThrow("no complete snapshot");
  });

  it("bounds network and credential waiting and respects caller cancellation", async () => {
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () => reject(new Error("fixture aborted")), {
            once: true,
          }),
        ),
    );
    await expect(discoverModels({ ...baseOptions, timeoutMs: 10, fetch })).rejects.toThrow(
      "no complete snapshot",
    );
    await expect(
      discoverModels({ ...baseOptions, timeoutMs: 10, apiKey: () => new Promise(() => {}), fetch }),
    ).rejects.toThrow("no complete snapshot");
    const stopped = new AbortController();
    stopped.abort();
    const resolver = vi.fn(() => "fixture-credential");
    await expect(
      discoverModels({ ...baseOptions, apiKey: resolver, signal: stopped.signal, fetch }),
    ).rejects.toThrow("no complete snapshot");
    expect(resolver).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects unsafe source URLs before credential resolution", async () => {
    const resolver = vi.fn(() => "fixture-credential");
    const credentials = new URL("https://example.test");
    credentials.username = "fixture-user";
    credentials.password = "not-a-secret";
    for (const baseUrl of [
      "http://example.test",
      credentials.href,
      "https://example.test/?key=synthetic",
      "https://example.test/#fragment",
    ])
      await expect(discoverModels({ ...baseOptions, baseUrl, apiKey: resolver })).rejects.toThrow(
        "no complete snapshot",
      );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("labels baseline and visibility changes without claiming a release or retirement", () => {
    const before = createDiscoverySnapshot(
      source,
      [{ id: "model-old" }, { id: "model-alpha" }],
      observedAt,
    );
    const after = createDiscoverySnapshot(
      source,
      [{ id: "model-new" }, { id: "model-alpha", vendor_created_at: observedAt }],
      "2026-10-09T01:00:00Z",
    );
    expect(discoveryRadar(before)).toMatchObject({
      status: "baseline",
      model_count: 2,
      added_models: [],
    });
    expect(discoveryRadar(after, before)).toMatchObject({
      status: "compared",
      added_models: ["model-new"],
      no_longer_visible_models: ["model-old"],
      metadata_changed_models: ["model-alpha"],
    });
    expect(() => discoveryRadar(before, after)).toThrow("Invalid catalog data");
    const other = createDiscoverySnapshot(
      { ...source, scope: "account-b" },
      [{ id: "model-alpha" }],
      observedAt,
    );
    expect(() => discoveryRadar(other, before)).toThrow("Invalid catalog data");
  });

  it("verifies canonical digests and rejects injected or changed content", () => {
    const snapshot = createDiscoverySnapshot(
      source,
      [{ id: "model-beta" }, { id: "model-alpha" }],
      observedAt,
    );
    expect(parseDiscoverySnapshot(snapshot)).toEqual(snapshot);
    const otherOrder = createDiscoverySnapshot(
      source,
      [{ id: "model-alpha" }, { id: "model-beta" }],
      observedAt,
    );
    expect(otherOrder.digest).toBe(snapshot.digest);
    expect(() =>
      parseDiscoverySnapshot({ ...snapshot, models: [{ id: "model-mutated" }] }),
    ).toThrow();
    expect(() => parseDiscoverySnapshot({ ...snapshot, complete: false })).toThrow();
    expect(() => parseDiscoverySnapshot({ ...snapshot, account_secret: "synthetic" })).toThrow();
  });
});

describe("private atomic discovery polling", () => {
  it("does not advance the baseline when the combined state exceeds its byte limit", async () => {
    const path = await directory();
    const options = { ...baseOptions, provider: "anthropic" as const, directory: path };
    await pollDiscovery({ ...options, fetch: async () => json(anthropic([])) });
    const before = await readFile(join(path, "state.json"), "utf8");
    let page = 0;
    await expect(
      pollDiscovery({
        ...options,
        fetch: async () => {
          const ids = Array.from(
            { length: 1000 },
            (_, index) =>
              `model-${String(page * 1000 + index).padStart(5, "0")}-${"x".repeat(240)}`,
          );
          return json(anthropic(ids, ++page < 10));
        },
      }),
    ).rejects.toThrow("previous state");
    expect(page).toBe(10);
    expect(await readFile(join(path, "state.json"), "utf8")).toBe(before);
  });

  it("creates a baseline then publishes one atomic changed snapshot/report", async () => {
    const path = await directory();
    const first = await pollDiscovery({
      ...baseOptions,
      directory: path,
      fetch: async () => json(openai()),
    });
    expect(first.status).toBe("baseline");
    const second = await pollDiscovery({
      ...baseOptions,
      directory: path,
      observedAt: "2026-10-09T01:00:00Z",
      fetch: async () => json(openai(["model-alpha", "model-beta"])),
    });
    expect(second.added_models).toEqual(["model-beta"]);
    const state = JSON.parse(await readFile(join(path, "state.json"), "utf8"));
    expect(state.radar).toEqual(second);
    expect(parseDiscoverySnapshot(state.snapshot).models).toHaveLength(2);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(path, "state.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps prior state byte-for-byte after incomplete refresh or corrupt local input", async () => {
    const path = await directory();
    await pollDiscovery({ ...baseOptions, directory: path, fetch: async () => json(openai()) });
    const file = join(path, "state.json");
    const before = await readFile(file, "utf8");
    await expect(
      pollDiscovery({
        ...baseOptions,
        directory: path,
        fetch: async () => new Response("synthetic-private-error", { status: 503 }),
      }),
    ).rejects.toThrow("previous state");
    expect(await readFile(file, "utf8")).toBe(before);
    await writeFile(file, "{broken}");
    const fetch = vi.fn(async () => json(openai()));
    await expect(pollDiscovery({ ...baseOptions, directory: path, fetch })).rejects.toThrow(
      "previous state",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("{broken}");
  });

  it("refuses overlapping writers and releases ownership after a failed poll", async () => {
    const path = await directory();
    let started!: () => void;
    let finish!: (response: Response) => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = pollDiscovery({
      ...baseOptions,
      directory: path,
      fetch: async () => {
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      },
    });
    await ready;
    const secondFetch = vi.fn(async () => json(openai()));
    await expect(
      pollDiscovery({ ...baseOptions, directory: path, fetch: secondFetch }),
    ).rejects.toThrow("previous state");
    expect(secondFetch).not.toHaveBeenCalled();
    finish(new Response("{}", { status: 503 }));
    await expect(pending).rejects.toThrow("previous state");
    expect(
      (await pollDiscovery({ ...baseOptions, directory: path, fetch: secondFetch })).status,
    ).toBe("baseline");
  });

  it("rejects shared permissions and symlink state without following it", async () => {
    const path = await directory();
    await chmod(path, 0o755);
    const fetch = vi.fn(async () => json(openai()));
    await expect(pollDiscovery({ ...baseOptions, directory: path, fetch })).rejects.toThrow();
    await chmod(path, 0o700);
    const target = join(path, "private-target");
    await writeFile(target, "synthetic-private-content", { mode: 0o600 });
    await symlink(target, join(path, "state.json"));
    await expect(pollDiscovery({ ...baseOptions, directory: path, fetch })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("synthetic-private-content");
    expect(fetch).not.toHaveBeenCalled();
  });
});
