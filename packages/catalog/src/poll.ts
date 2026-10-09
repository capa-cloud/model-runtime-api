import { constants, type Stats } from "node:fs";
import { open, mkdir, lstat, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import {
  discoverModels,
  discoveryRadar,
  parseDiscoverySnapshot,
  type DiscoveryOptions,
} from "./discovery.js";
import { record } from "./validation.js";

export async function readLocalJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4 * 1024 * 1024)
      throw new Error("Invalid catalog input file");
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > 4 * 1024 * 1024) throw new Error("Catalog input file exceeds limit");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function pollDiscovery(options: DiscoveryOptions & { directory: string }) {
  const directory = resolve(options.directory);
  let release: (() => Promise<void>) | undefined;
  let temporary: string | undefined;
  let compromised = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assertPrivate(await lstat(directory), true);
    release = await lockfile.lock(directory, {
      realpath: false,
      retries: 0,
      stale: 30000,
      update: 10000,
      onCompromised() {
        compromised = true;
      },
    });
    const statePath = join(directory, "state.json");
    let previous;
    try {
      assertPrivate(await lstat(statePath), false);
      const state = record(await readLocalJson(statePath), ["state_version", "snapshot", "radar"]);
      if (state.state_version !== "1") throw new Error("Invalid discovery state");
      previous = parseDiscoverySnapshot(state.snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const snapshot = await discoverModels(options);
    const radar = discoveryRadar(snapshot, previous);
    const payload = `${JSON.stringify({ state_version: "1", snapshot, radar }, null, 2)}\n`;
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024)
      throw new Error("Discovery state exceeds limit");
    if (compromised) throw new Error("Discovery writer ownership was lost");
    temporary = join(directory, `${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (compromised) throw new Error("Discovery writer ownership was lost");
    await rename(temporary, statePath);
    temporary = undefined;
    const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
    return radar;
  } catch {
    throw new Error(
      "Discovery poll failed; previous state must not be treated as a fresh observation",
    );
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
    await release?.().catch(() => undefined);
  }
}

function assertPrivate(info: Stats, directory: boolean): void {
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Unsafe discovery state permissions");
}
