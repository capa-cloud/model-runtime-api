import { randomUUID, createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  appendFile,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileEventStore, InMemoryEventStore, ModelRuntime } from "@model-runtime/core";
import { MockProvider } from "@model-runtime/provider-mock";
import type { RuntimeEvent } from "@model-runtime/protocol";

const directories: string[] = [];
const stores: FileEventStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const request = { ability: "text-generation", input: [{ type: "text" as const, text: "fixture" }] };
const key = () => Buffer.alloc(32, 7);
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "runtime-store-fixture-"));
  directories.push(path);
  await chmod(path, 0o700);
  return path;
}
async function fileStore(
  path: string,
  options: Partial<Parameters<typeof FileEventStore.open>[0]> = {},
) {
  const store = await FileEventStore.open({ directory: path, encryptionKey: key(), ...options });
  stores.push(store);
  return store;
}
function accepted(id: string, sequence = 1): RuntimeEvent {
  return {
    type: "execution.accepted",
    status: "accepted",
    execution_id: id,
    sequence,
    time: new Date().toISOString(),
  };
}
function completed(id: string, sequence = 2): RuntimeEvent {
  return {
    type: "execution.completed",
    status: "succeeded",
    execution_id: id,
    sequence,
    time: new Date().toISOString(),
    target: { provider: "provider-a", model: "model-alpha" },
  };
}

describe("bounded event store contract", () => {
  it("replays a terminal event committed between list and status reads", async () => {
    const id = randomUUID();
    let injected = false;
    class RacingStore extends InMemoryEventStore {
      override async list(executionId: string, after = 0) {
        const events = await super.list(executionId, after);
        if (!injected) {
          injected = true;
          await this.append(completed(executionId));
        }
        return events;
      }
    }
    const store = new RacingStore();
    await store.create(id, new Date().toISOString());
    await store.append(accepted(id));
    const events = [];
    for await (const event of store.watch(id)) events.push(event);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("pins history while a subscriber is reading and releases it on close", async () => {
    const store = new InMemoryEventStore({ maxExecutions: 1 });
    const id = randomUUID(),
      next = randomUUID();
    await store.create(id, new Date().toISOString());
    await store.append(accepted(id));
    const reader = store.watch(id)[Symbol.asyncIterator]();
    await reader.next();
    await store.append(completed(id));
    await expect(store.create(next, new Date().toISOString())).rejects.toMatchObject({
      code: "queue_full",
    });
    expect((await reader.next()).value?.type).toBe("execution.completed");
    await reader.return(undefined);
    await store.create(next, new Date().toISOString());
    expect(await store.get(id)).toBeUndefined();
  });
  it("enforces contiguous sequences and immutable terminal state", async () => {
    const store = new InMemoryEventStore();
    const id = randomUUID();
    await store.create(id, new Date().toISOString());
    await expect(store.append(accepted(id, 2))).rejects.toMatchObject({ code: "internal_error" });
    await store.append(accepted(id));
    await store.append(completed(id));
    await expect(store.append({ ...accepted(id), sequence: 3 })).rejects.toMatchObject({
      code: "internal_error",
    });
  });

  it("evicts completed history but never active executions to satisfy capacity", async () => {
    const store = new InMemoryEventStore({ maxExecutions: 1 });
    const first = randomUUID(),
      second = randomUUID();
    await store.create(first, new Date().toISOString());
    await expect(store.create(second, new Date().toISOString())).rejects.toMatchObject({
      code: "queue_full",
    });
    await store.append(accepted(first));
    await store.append(completed(first));
    await store.create(second, new Date().toISOString());
    expect(await store.get(first)).toBeUndefined();
    expect(await store.get(second)).toBeDefined();
  });

  it("expires terminal records and their idempotency identities together", async () => {
    let now = Date.now();
    const store = new InMemoryEventStore({ retentionMs: 10, now: () => now });
    const identity = {
      key_hash: createHash("sha256").update("fixture-key").digest("hex"),
      fingerprint: "a".repeat(64),
    };
    const id = randomUUID();
    await store.claim(id, new Date(now).toISOString(), identity);
    await store.append(accepted(id));
    await store.append(completed(id));
    now += 1000;
    expect(await store.get(id)).toBeUndefined();
    expect(await store.lookupIdentity(identity)).toBeUndefined();
  });

  it("materializes a terminal failure when streaming exceeds retention capacity", async () => {
    const store = new InMemoryEventStore({ maxExecutionBytes: 700 });
    const runtime = new ModelRuntime({ eventStore: store });
    runtime.register(new MockProvider({ chunks: ["x".repeat(1000)] }));
    const submitted = await runtime.submit(request);
    await runtime.waitForIdle();
    expect(await runtime.get(submitted.execution_id)).toMatchObject({
      status: "failed",
      error: { code: "queue_full", retryable: false },
    });
  });

  it("coalesces same-key submissions with a single execution slot", async () => {
    const runtime = new ModelRuntime({ maxActiveExecutions: 1 });
    runtime.register(new MockProvider({ delayMs: 100 }));
    const [first, second] = await Promise.all([
      runtime.submit(request, "fixture"),
      runtime.submit(request, "fixture"),
    ]);
    expect(second.execution_id).toBe(first.execution_id);
    const replay = await runtime.submit(request, "fixture");
    expect(replay.execution_id).toBe(first.execution_id);
    await expect(runtime.submit(request)).rejects.toMatchObject({ code: "queue_full" });
    await runtime.shutdown();
  });

  it("copies request data before asynchronous routing", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());
    const input = structuredClone(request);
    const operation = runtime.submit(input);
    input.ability = "changed";
    await runtime.waitForIdle();
    const submitted = await operation;
    await runtime.waitForIdle();
    expect(await runtime.get(submitted.execution_id)).toMatchObject({ status: "succeeded" });
  });

  it("stops consuming provider events at completion rather than waiting for EOF", async () => {
    const runtime = new ModelRuntime();
    const mock = new MockProvider();
    let tailRead = false;
    runtime.register({
      id: mock.id,
      manifest: () => mock.manifest(),
      async *execute() {
        yield { type: "output.delta", output_index: 0, delta: "complete" } as const;
        yield { type: "execution.completed" } as const;
        tailRead = true;
        throw new Error("Must not consume past completion");
      },
    });
    const submitted = await runtime.submit(request);
    await runtime.waitForIdle();
    expect(await runtime.get(submitted.execution_id)).toMatchObject({ status: "succeeded" });
    expect(tailRead).toBe(false);
  });

  it("bounds embedded idempotency keys and rejects data lost by JSON serialization", async () => {
    const runtime = new ModelRuntime();
    runtime.register(new MockProvider());
    await expect(runtime.submit(request, "x".repeat(257))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      runtime.submit({
        ability: "text-generation",
        input: [{ type: "json", value: () => "fixture" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("encrypted file event store", () => {
  it("preserves terminal failure evidence when the encrypted disk budget is exhausted", async () => {
    const path = await directory();
    const store = await fileStore(path, { maxDiskBytes: 2000 });
    const runtime = new ModelRuntime({ eventStore: store });
    runtime.register(new MockProvider({ chunks: ["x".repeat(4000)] }));
    const submitted = await runtime.submit(request);
    await runtime.waitForIdle();
    expect(await runtime.get(submitted.execution_id)).toMatchObject({
      status: "failed",
      error: { code: "queue_full", retryable: false },
    });
    await runtime.close();
    const reopened = await fileStore(path, { maxDiskBytes: 2000 });
    expect(await reopened.get(submitted.execution_id)).toMatchObject({ status: "failed" });
  });
  it("survives reopen with status/result/events and idempotency intact without re-executing", async () => {
    const path = await directory();
    const firstStore = await fileStore(path);
    const first = new ModelRuntime({ eventStore: firstStore });
    first.register(new MockProvider({ chunks: ["fixture-sensitive-output"] }));
    const submitted = await first.submit(request, "fixture-sensitive-key");
    await first.waitForIdle();
    const before = await first.get(submitted.execution_id);
    await first.close();
    const serialized = await readFile(join(path, submitted.execution_id + ".jsonl"), "utf8");
    expect(serialized).not.toContain("fixture-sensitive-output");
    expect(serialized).not.toContain("fixture-sensitive-key");
    const secondStore = await fileStore(path);
    const second = new ModelRuntime({ eventStore: secondStore });
    second.register(new MockProvider({ chunks: ["must-not-execute"] }));
    const replay = await second.submit(request, "fixture-sensitive-key");
    expect(replay).toMatchObject({
      execution_id: submitted.execution_id,
      idempotent_replay: true,
      status: "succeeded",
    });
    expect(await second.get(replay.execution_id)).toEqual(before);
    await expect(
      second.submit({ ...request, ability: "other" }, "fixture-sensitive-key"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const events = [];
    for await (const event of second.events(replay.execution_id, 3)) events.push(event);
    expect(events[0]?.sequence).toBe(4);
    expect(events.at(-1)?.type).toBe("execution.completed");
    await second.close();
  });

  it("marks interrupted executions failed, non-retryable and replayable", async () => {
    const path = await directory();
    const store = await fileStore(path);
    const id = randomUUID();
    const identity = {
      key_hash: createHash("sha256").update("fixture").digest("hex"),
      fingerprint: "b".repeat(64),
    };
    await store.claim(id, new Date().toISOString(), identity);
    await store.append(accepted(id));
    await store.close();
    const reopened = await fileStore(path);
    expect(await reopened.get(id)).toMatchObject({
      status: "failed",
      last_sequence: 2,
      error: { code: "internal_error", retryable: false },
    });
    expect(await reopened.claim(randomUUID(), new Date().toISOString(), identity)).toMatchObject({
      execution_id: id,
      replay: true,
    });
  });

  it("rejects an overlapping writer and releases ownership on close", async () => {
    const path = await directory();
    const store = await fileStore(path);
    await expect(fileStore(path)).rejects.toMatchObject({ code: "internal_error" });
    await store.close();
    await expect(fileStore(path)).resolves.toBeDefined();
  });

  it("fails closed on a wrong key or tampered complete record without exposing content", async () => {
    const path = await directory();
    const store = await fileStore(path);
    const id = randomUUID();
    await store.create(id, new Date().toISOString());
    await store.append(accepted(id));
    await store.close();
    const before = await readFile(join(path, id + ".jsonl"));
    await expect(fileStore(path, { encryptionKey: Buffer.alloc(32, 9) })).rejects.toMatchObject({
      code: "internal_error",
    });
    expect(await readFile(join(path, id + ".jsonl"))).toEqual(before);
    const lines = before.toString().trimEnd().split("\n");
    const envelope = JSON.parse(lines[1]!);
    envelope.data = "a".repeat(envelope.data.length);
    lines[1] = JSON.stringify(envelope);
    await writeFile(join(path, id + ".jsonl"), lines.join("\n") + "\n", { mode: 0o600 });
    await expect(fileStore(path)).rejects.toMatchObject({
      message: "Encrypted event store could not be opened",
    });
  });

  it("discards only an unterminated crash tail after authenticating committed records", async () => {
    const path = await directory();
    const store = await fileStore(path);
    const id = randomUUID();
    await store.create(id, new Date().toISOString());
    await store.append(accepted(id));
    await store.close();
    await appendFile(join(path, id + ".jsonl"), '{"partial":');
    const reopened = await fileStore(path);
    expect(await reopened.get(id)).toMatchObject({ status: "failed", last_sequence: 2 });
    expect((await readFile(join(path, id + ".jsonl"), "utf8")).endsWith("\n")).toBe(true);
  });

  it("rejects unsafe directories, symlink journals and path traversal lookups", async () => {
    const path = await directory();
    await chmod(path, 0o755);
    await expect(fileStore(path)).rejects.toMatchObject({ code: "internal_error" });
    await chmod(path, 0o700);
    const external = join(path, "external");
    await writeFile(external, "fixture", { mode: 0o600 });
    await symlink(external, join(path, randomUUID() + ".jsonl"));
    await expect(fileStore(path)).rejects.toMatchObject({ code: "internal_error" });
    await unlinkFixtureSymlinks(path);
    const safe = await fileStore(path);
    expect(await safe.get("../external")).toBeUndefined();
  });

  it("wakes subscribers and fails closed if an append cannot reach its journal", async () => {
    const path = await directory();
    const store = await fileStore(path);
    const id = randomUUID();
    await store.create(id, new Date().toISOString());
    await store.append(accepted(id));
    const watcher = store.watch(id, 1)[Symbol.asyncIterator]();
    const waiting = watcher.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await rm(join(path, id + ".jsonl"));
    await expect(store.append(completed(id))).rejects.toMatchObject({ code: "internal_error" });
    await expect(waiting).rejects.toMatchObject({ code: "internal_error" });
    expect(store.available()).toBe(false);
  });

  it("evicts encrypted terminal files and expires keys under retention policy", async () => {
    let now = Date.now();
    const path = await directory();
    const store = await fileStore(path, { retentionMs: 10, now: () => now });
    const id = randomUUID();
    const identity = { key_hash: "c".repeat(64), fingerprint: "d".repeat(64) };
    await store.claim(id, new Date().toISOString(), identity);
    await store.append(accepted(id));
    await store.append(completed(id));
    now += 1000;
    expect(await store.get(id)).toBeUndefined();
    expect(await store.lookupIdentity(identity)).toBeUndefined();
    expect((await readdir(path)).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  });
});

async function unlinkFixtureSymlinks(path: string) {
  for (const name of await readdir(path)) if (name.endsWith(".jsonl")) await rm(join(path, name));
}
