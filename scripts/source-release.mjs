import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { assertAuditEnvironment, createScanner } from "./public-audit.mjs";

const maximumArchiveBytes = 64 * 1024 * 1024;
const maximumSourceBytes = 32 * 1024 * 1024;
const prefix = "model-runtime-api/";
const archiveName = "model-runtime-api-source.tar.gz";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(root, args, binary = false) {
  try {
    return execFileSync("git", ["-c", "core.attributesFile=/dev/null", ...args], {
      cwd: root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1" },
      encoding: binary ? undefined : "utf8",
      timeout: 30_000,
      maxBuffer: maximumArchiveBytes,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Release Git evidence is unavailable");
  }
}

async function readBounded(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum) throw new Error("Invalid release file");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== before.size) throw new Error("Release file changed while reading");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function verifyTar(tar, files) {
  const directory = await mkdtemp(join(tmpdir(), "model-runtime-release-check-"));
  try {
    // Only extract the tar just produced by Git from the audited, path-checked tree.
    execFileSync("tar", ["-xf", "-", "-C", directory], {
      input: tar,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const expected = new Map(files.map((file) => [`${prefix}${file.path}`, file]));
    async function walk(path = "") {
      for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
        const name = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(name);
        else {
          const file = expected.get(name);
          if (!entry.isFile() || !file) throw new Error("Unexpected archive entry");
          const bytes = await readBounded(join(directory, name), 8 * 1024 * 1024);
          if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
            throw new Error("Archive does not match the audited tree");
          expected.delete(name);
        }
      }
    }
    await walk();
    if (expected.size) throw new Error("Archive omitted audited files");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function buildSourceRelease(root, commit, literals = []) {
  assertAuditEnvironment();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Use an exact full commit SHA");
  if (git(root, ["rev-parse", "--verify", `${commit}^{commit}`]).trim() !== commit)
    throw new Error("Release commit identity differs");
  const scanner = await createScanner(root, literals);
  const entries = git(root, ["ls-tree", "-r", "-l", "-z", commit]).split("\0").filter(Boolean);
  if (!entries.length || entries.length > 2048) throw new Error("Release tree limit exceeded");
  const files = [];
  let total = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Release accepts regular files only");
    const [, mode, object, size, path] = match;
    if (
      !/^[A-Za-z0-9._/-]+$/.test(path) ||
      path
        .split("/")
        .some((part) => ["", ".", "..", ".gitattributes", "dist", "__pycache__"].includes(part)) ||
      path.endsWith(".tsbuildinfo")
    )
      throw new Error("Unsafe or generated release path");
    total += Number(size);
    if (Number(size) > 8 * 1024 * 1024 || total > maximumSourceBytes)
      throw new Error("Release source byte limit exceeded");
    const bytes = git(root, ["cat-file", "blob", object], true);
    if (bytes.length !== Number(size)) throw new Error("Release blob size differs");
    if ((await scanner.scan(bytes, path, "release", object)).length)
      throw new Error("Release source audit failed; inspect a separate sanitized audit report");
    files.push({ path, mode, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const packageFile = files.find((file) => file.path === "package.json");
  if (!packageFile || !files.some((file) => file.path === "LICENSE"))
    throw new Error("Release project identity is missing");
  const packageJson = JSON.parse(git(root, ["show", `${commit}:package.json`]));
  if (packageJson.name !== "model-runtime-api") throw new Error("Wrong release project");
  const tar = git(root, ["archive", "--format=tar", `--prefix=${prefix}`, commit], true);
  await verifyTar(tar, files);
  const archive = gzipSync(tar, { level: 9 });
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        format: "model-runtime-source-release-v1",
        commit,
        tree: git(root, ["rev-parse", `${commit}^{tree}`]).trim(),
        toolchain: {
          node: process.versions.node,
          zlib: process.versions.zlib,
          git: git(root, ["--version"]).trim(),
        },
        archive: { name: archiveName, bytes: archive.length, sha256: sha256(archive) },
        files,
      },
      null,
      2,
    )}\n`,
  );
  const checksums = Buffer.from(
    `${sha256(archive)}  ${archiveName}\n${sha256(manifest)}  source-manifest.json\n`,
  );
  return { archive, manifest, checksums };
}

export async function prepareSourceRelease(root, commit, parent, literals = []) {
  const repository = await realpath(root);
  const destination = await realpath(parent);
  const path = relative(repository, destination);
  if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    throw new Error("Release output must live outside the repository");
  const result = await buildSourceRelease(root, commit, literals);
  const directory = await mkdtemp(join(destination, "model-runtime-source-"));
  try {
    for (const [name, bytes] of [
      [archiveName, result.archive],
      ["source-manifest.json", result.manifest],
      ["SHA256SUMS", result.checksums],
    ])
      await writeFile(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
    return directory;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Release output could not be prepared");
  }
}

export async function verifySourceRelease(root, commit, directory, literals = []) {
  assertAuditEnvironment();
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid release directory");
  const names = (await readdir(directory)).sort();
  const expected = ["SHA256SUMS", archiveName, "source-manifest.json"].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error("Unexpected release files");
  const result = await buildSourceRelease(root, commit, literals);
  for (const [name, bytes] of [
    [archiveName, result.archive],
    ["source-manifest.json", result.manifest],
    ["SHA256SUMS", result.checksums],
  ])
    if (!(await readBounded(join(directory, name), maximumArchiveBytes)).equals(bytes))
      throw new Error("Release bytes differ from the audited commit and toolchain");
  return { passed: true, commit, files: JSON.parse(result.manifest).files.length };
}
