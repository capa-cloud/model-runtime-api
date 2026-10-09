import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import {
  InMemoryEventStore,
  assertEvent,
  isTerminal,
  type EventStoreLimits,
  type StoreEntry,
} from "./event-store.js";
import { RuntimeError } from "./errors.js";
import type { RuntimeEvent } from "@model-runtime/protocol";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type RecordValue =
  | { kind: "create"; id: string; created_at: string; identity?: StoreEntry["identity"] }
  | { kind: "event"; event: RuntimeEvent };
export interface FileEventStoreOptions extends EventStoreLimits {
  directory: string;
  encryptionKey: Uint8Array;
  maxDiskBytes?: number;
}

export class FileEventStore extends InMemoryEventStore {
  readonly #directory: string;
  readonly #key: Buffer;
  readonly #sizes = new Map<string, number>();
  readonly #maxDiskBytes: number;
  #diskBytes = 0;
  #release?: () => Promise<void>;
  #closed = false;
  #failed = false;

  private constructor(options: FileEventStoreOptions) {
    super(options);
    if (options.encryptionKey.byteLength !== 32)
      throw new Error("Store encryption key must contain 32 bytes");
    this.#directory = resolve(options.directory);
    this.#key = Buffer.from(options.encryptionKey);
    this.#maxDiskBytes = options.maxDiskBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxDiskBytes) || this.#maxDiskBytes < 1)
      throw new Error("Invalid disk limit");
    if (
      this.limits.maxExecutionBytes > 8 * 1024 * 1024 ||
      this.limits.maxEvents > 8192 ||
      this.limits.maxExecutions > 10000 ||
      this.#maxDiskBytes > 1024 * 1024 * 1024
    )
      throw new Error("File store limits exceed the supported profile");
  }

  static async open(options: FileEventStoreOptions): Promise<FileEventStore> {
    const store = new FileEventStore(options);
    try {
      await mkdir(store.#directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(store.#directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      )
        throw new Error("Unsafe store directory");
      store.#release = await lock(store.#directory, {
        stale: 30000,
        update: 10000,
        retries: 0,
        onCompromised: () => store.fail(),
      });
      await store.restore();
      return store;
    } catch {
      await store.#release?.().catch(() => undefined);
      store.#key.fill(0);
      throw new RuntimeError("internal_error", "Encrypted event store could not be opened");
    }
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    await this.write(async () => {
      this.#closed = true;
      for (const entry of this.entries.values()) {
        for (const wake of entry.waiters) wake();
        entry.waiters.clear();
      }
      await this.#release?.();
      this.#release = undefined;
      this.#key.fill(0);
      this.entries.clear();
      this.bytes = 0;
    }).catch(async () => {
      this.fail();
      this.#closed = true;
      this.#key.fill(0);
      this.entries.clear();
      this.bytes = 0;
      await this.#release?.().catch(() => undefined);
      this.#release = undefined;
    });
  }

  protected override assertAvailable(): void {
    if (this.#closed || this.#failed)
      throw new RuntimeError("internal_error", "Encrypted event store is unavailable");
  }
  override available(): boolean {
    return !this.#closed && !this.#failed;
  }
  private fail(): void {
    this.#failed = true;
    for (const entry of this.entries.values()) {
      for (const wake of entry.waiters) wake();
      entry.waiters.clear();
    }
  }

  protected override async persistCreate(id: string, entry: StoreEntry): Promise<void> {
    if (!uuid.test(id))
      throw new RuntimeError("invalid_request", "File store requires a UUID execution ID");
    const line = this.encode(id, {
      kind: "create",
      id,
      created_at: entry.createdAt,
      identity: entry.identity,
    });
    await this.diskRoom(line.byteLength);
    await this.io(async () => {
      const handle = await open(this.path(id), "wx", 0o600);
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.syncDirectory();
    });
    this.#sizes.set(id, line.byteLength);
    this.#diskBytes += line.byteLength;
  }

  protected override async persistAppend(id: string, event: RuntimeEvent): Promise<void> {
    const line = this.encode(id, { kind: "event", event });
    if (!isTerminal(event)) await this.diskRoom(line.byteLength, id);
    await this.io(async () => {
      const handle = await open(
        this.path(id),
        constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      );
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.#sizes.set(id, (this.#sizes.get(id) ?? 0) + line.byteLength);
    this.#diskBytes += line.byteLength;
  }

  protected override async persistDelete(id: string): Promise<void> {
    await this.io(async () => {
      await unlink(this.path(id));
      await this.syncDirectory();
    });
    this.#diskBytes -= this.#sizes.get(id) ?? 0;
    this.#sizes.delete(id);
  }

  private async diskRoom(bytes: number, exclude?: string): Promise<void> {
    while (this.#diskBytes + bytes > this.#maxDiskBytes) {
      if (!(await this.evictOldest(exclude)))
        throw new RuntimeError("queue_full", "Encrypted event store disk capacity exhausted");
    }
  }
  private path(id: string): string {
    if (!uuid.test(id)) throw new RuntimeError("invalid_request", "Invalid execution ID");
    return join(this.#directory, id + ".jsonl");
  }
  override async get(id: string) {
    if (!uuid.test(id)) return undefined;
    return super.get(id);
  }
  override async list(id: string, after = 0) {
    if (!uuid.test(id)) return [];
    return super.list(id, after);
  }

  private encode(id: string, value: RecordValue): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from("model-runtime-event-store/v1/" + id));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.from(
      JSON.stringify({
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: ciphertext.toString("base64"),
      }) + "\n",
    );
  }
  private decode(id: string, line: string): RecordValue {
    const record = JSON.parse(line);
    if (
      record.version !== 1 ||
      typeof record.iv !== "string" ||
      typeof record.tag !== "string" ||
      typeof record.data !== "string"
    )
      throw new Error("Invalid encrypted record");
    const iv = Buffer.from(record.iv, "base64"),
      tag = Buffer.from(record.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encryption envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAAD(Buffer.from("model-runtime-event-store/v1/" + id));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(record.data, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  }

  private async restore(): Promise<void> {
    const names = (await readdir(this.#directory)).sort();
    const files = names.filter((name) => name.endsWith(".jsonl"));
    if (files.length > this.limits.maxExecutions) throw new Error("Too many stored executions");
    const identities = new Set<string>();
    const repairs: { id: string; length: number }[] = [];
    for (const name of files) {
      const id = name.slice(0, -6);
      const path = this.path(id);
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 16 * 1024 * 1024 ||
        (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      )
        throw new Error("Unsafe event journal");
      this.#diskBytes += stat.size;
      if (this.#diskBytes > this.#maxDiskBytes + this.limits.maxExecutions * 4096)
        throw new Error("Store exceeds disk capacity");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const raw = await handle.readFile();
        const lastNewline = raw.lastIndexOf(10);
        if (lastNewline < 0) throw new Error("Journal header was not committed");
        // Discard only an unterminated crash tail; authenticated complete records remain mandatory.
        if (lastNewline + 1 !== raw.length) repairs.push({ id, length: lastNewline + 1 });
        this.#sizes.set(id, lastNewline + 1);
        this.#diskBytes -= raw.length - lastNewline - 1;
        const lines = raw.subarray(0, lastNewline).toString("utf8").split("\n");
        const header = this.decode(id, lines.shift()!);
        if (
          header.kind !== "create" ||
          header.id !== id ||
          !Number.isFinite(Date.parse(header.created_at))
        )
          throw new Error("Invalid journal header");
        if (
          header.identity &&
          (!/^[a-f0-9]{64}$/.test(header.identity.key_hash) ||
            !/^[a-f0-9]{64}$/.test(header.identity.fingerprint) ||
            identities.has(header.identity.key_hash))
        )
          throw new Error("Invalid stored identity");
        if (header.identity) identities.add(header.identity.key_hash);
        const entry: StoreEntry = {
          createdAt: header.created_at,
          identity: header.identity,
          events: [],
          bytes: 256,
          waiters: new Set(),
          readers: 0,
        };
        for (const line of lines) {
          const value = this.decode(id, line);
          if (value.kind !== "event") throw new Error("Invalid record kind");
          assertEvent(value.event);
          if (
            value.event.execution_id !== id ||
            value.event.sequence !== entry.events.length + 1 ||
            (entry.events.length && isTerminal(entry.events.at(-1)!))
          )
            throw new Error("Invalid recovered sequence");
          entry.events.push(value.event);
          entry.bytes += Buffer.byteLength(JSON.stringify(value.event));
        }
        if (
          entry.bytes > this.limits.maxExecutionBytes + 2048 ||
          entry.events.length > this.limits.maxEvents + 1
        )
          throw new Error("Execution exceeds limits");
        this.entries.set(id, entry);
        this.bytes += entry.bytes;
      } finally {
        await handle.close();
      }
    }
    // Validate every authenticated journal before making any recovery mutation.
    for (const repair of repairs) {
      const handle = await open(this.path(repair.id), constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await handle.truncate(repair.length);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.expire();
    await this.ensureRoom(0, false);
    for (const [id, entry] of this.entries) {
      if (!entry.events.length || !isTerminal(entry.events.at(-1)!)) {
        await this.append({
          type: "execution.failed",
          status: "failed",
          execution_id: id,
          sequence: entry.events.length + 1,
          time: new Date().toISOString(),
          error: {
            code: "internal_error",
            message: "Execution was interrupted by a runtime restart; remote outcome is unknown",
            retryable: false,
          },
        });
      }
    }
  }
  private async syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async io(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      this.fail();
      throw new RuntimeError("internal_error", "Encrypted event store write failed");
    }
  }
}
