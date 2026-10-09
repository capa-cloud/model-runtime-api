import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "@secretlint/node";

const maximumBytes = 8 * 1024 * 1024;
const maximumTotalBytes = 512 * 1024 * 1024;
const rules = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential_token", /\b(?:sk-|gh[pousr]_|glpat-)[A-Za-z0-9_-]{12,}\b/],
  ["bearer_credential", /authorization["']?\s*:\s*["']?bearer\s+([A-Za-z0-9._~-]{12,})/i],
  ["local_absolute_path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  [
    "private_ipv4",
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  ],
  ["private_domain", /\b[A-Za-z0-9.-]+\.(?:internal|corp|localdomain)\b/i],
];
const placeholders = new Set(["fixture-credential", "provided-by-secret-manager"]);
export const locationDigest = (value) => createHash("sha256").update(value).digest("hex");

export function assertAuditEnvironment() {
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE"].some((key) => Boolean(process.env[key])))
    throw new Error("Debug logging must be disabled for privacy auditing");
}

export function git(root, args, buffer = false) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: buffer ? undefined : "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Git evidence could not be read completely");
  }
}

async function readBounded(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error("Unsupported audit input");
    const data = Buffer.alloc(Math.min(info.size + 1, maximumBytes + 1));
    let offset = 0;
    while (offset < data.length) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== info.size) throw new Error("Audit input changed during reading");
    return data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function loadPrivatePolicy(root, path) {
  if (!path) return [];
  const target = await realpath(path);
  const inside = relative(await realpath(root), target);
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    throw new Error("Private audit policy must live outside the repository");
  const value = JSON.parse((await readBounded(target)).toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "literals") ||
    !Array.isArray(value.literals) ||
    value.literals.length > 128 ||
    value.literals.some((item) => typeof item !== "string" || item.length < 3 || item.length > 256)
  )
    throw new Error("Invalid private audit policy");
  return value.literals.map((item) => item.toLowerCase());
}

function filenameFindings(path) {
  const parts = path.split("/");
  const last = parts.at(-1);
  const findings = [];
  if (isAbsolute(path) || parts.some((part) => part === "..") || /[\x00-\x1f\x7f]/.test(path))
    findings.push("unsafe_filename");
  if (
    parts.some((part) =>
      [".git", "node_modules", ".runtime-data", ".model-research"].includes(part),
    ) ||
    /^(?:\.DS_Store|id_rsa|id_ed25519|credentials(?:\.json)?)$/.test(last) ||
    ((/^\.env(?:\.|$)/.test(last) || /\.(?:pem|key|p12|pfx|jsonl)$/.test(last)) &&
      !last.endsWith(".example"))
  )
    findings.push("dangerous_file");
  if (/\.(?:zip|gz|tgz|tar|7z|rar|pdf|exe|dll|so|node|wasm)$/i.test(last))
    findings.push("opaque_artifact_requires_review");
  return findings;
}

export async function createScanner(root, literals = []) {
  assertAuditEnvironment();
  const engine = await createEngine({
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    formatter: "json",
    color: false,
    terminalLink: false,
    maskSecrets: true,
    configFileJSON: { rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }] },
  });
  let bytes = 0;
  return {
    async scan(content, path, kind, objectId) {
      const location = {
        kind,
        location_digest: locationDigest(path),
        ...(objectId ? { object_id: objectId } : {}),
      };
      const findings = filenameFindings(path).map((category) => ({ ...location, category }));
      if (content.length > maximumBytes || bytes + content.length > maximumTotalBytes)
        return [...findings, { ...location, category: "audit_byte_limit" }];
      bytes += content.length;
      const utf16 =
        content[0] === 0xff && content[1] === 0xfe
          ? "utf-16le"
          : content[0] === 0xfe && content[1] === 0xff
            ? "utf-16be"
            : undefined;
      const text = utf16
        ? new TextDecoder(utf16, { fatal: true }).decode(content)
        : content.toString("utf8");
      for (const [category, pattern] of rules) {
        const match = text.match(pattern);
        if (match && !(category === "bearer_credential" && placeholders.has(match[1])))
          findings.push({
            ...location,
            category,
            line: text.slice(0, match.index).split("\n").length,
          });
      }
      const lower = `${path}\n${text}`.toLowerCase();
      for (let index = 0; index < literals.length; index++)
        if (lower.includes(literals[index]))
          findings.push({ ...location, category: "private_literal", policy_index: index });
      const result = await engine.executeOnContent({
        content: text,
        filePath: resolve(root, path),
      });
      const rows = JSON.parse(result.output);
      if (!Array.isArray(rows)) throw new Error("Secret detector did not produce a valid result");
      let count = 0;
      for (const row of rows)
        for (const message of row.messages ?? []) {
          count++;
          findings.push({
            ...location,
            category: "secretlint",
            rule_id: message.ruleId,
            line: message.loc?.start?.line,
          });
        }
      if (!result.ok && !count) throw new Error("Secret detector failed without a diagnostic");
      return findings;
    },
    bytes() {
      return bytes;
    },
  };
}

function indexEntries(root, snapshot) {
  return (snapshot ?? git(root, ["ls-files", "--stage", "-z"]))
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^([0-9]+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Incomplete index inventory");
      return { mode: match[1], objectId: match[2], stage: Number(match[3]), path: match[4] };
    });
}

export async function auditWorktree(root, literals = []) {
  assertAuditEnvironment();
  const indexSnapshot = git(root, ["ls-files", "--stage", "-z"]);
  const scanner = await createScanner(root, literals);
  const findings = [];
  const entries = indexEntries(root, indexSnapshot);
  const paths = new Set(entries.map((entry) => entry.path));
  for (const path of git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean))
    paths.add(path);
  for (const entry of entries) {
    if (entry.stage !== 0 || !["100644", "100755"].includes(entry.mode))
      findings.push({
        kind: "index",
        location_digest: locationDigest(entry.path),
        object_id: entry.objectId,
        category: "unsupported_index_entry",
      });
    else {
      const size = Number(git(root, ["cat-file", "-s", entry.objectId]).trim());
      findings.push(
        ...(await scanner.scan(
          size > maximumBytes
            ? Buffer.alloc(maximumBytes + 1)
            : git(root, ["cat-file", "blob", entry.objectId], true),
          entry.path,
          "index",
          entry.objectId,
        )),
      );
    }
  }
  for (const path of paths) {
    if (filenameFindings(path).includes("unsafe_filename")) {
      findings.push({
        kind: "worktree",
        location_digest: locationDigest(path),
        category: "unsafe_filename",
      });
      continue;
    }
    try {
      const info = await lstat(resolve(root, path));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsupported file");
      findings.push(
        ...(await scanner.scan(await readBounded(resolve(root, path)), path, "worktree")),
      );
    } catch {
      findings.push({
        kind: "worktree",
        location_digest: locationDigest(path),
        category: "unreadable_or_oversized_file",
      });
    }
  }
  if (git(root, ["ls-files", "--stage", "-z"]) !== indexSnapshot)
    throw new Error("Index changed during audit");
  return {
    schema_version: "public-audit/1",
    scope: "index_and_worktree",
    index_digest: locationDigest(indexSnapshot),
    observed_at: new Date().toISOString(),
    files: paths.size,
    index_entries: entries.length,
    scanned_bytes: scanner.bytes(),
    findings,
    passed: findings.length === 0,
  };
}

export async function auditHistory(root, literals = []) {
  assertAuditEnvironment();
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() !== "false")
    throw new Error("Complete history is required");
  const refRows = git(root, ["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)"])
    .trim()
    .split("\n")
    .filter(Boolean);
  const refs = refRows.map((row) => {
    const [name, objectId, type] = row.split(" ");
    return { name_digest: locationDigest(name), object_id: objectId, type };
  });
  const commits = git(root, ["rev-list", "--all"]).trim().split("\n").filter(Boolean);
  if (commits.length > 10000 || refs.length > 1000)
    throw new Error("History inventory exceeds limits");
  const scanner = await createScanner(root, literals);
  const findings = [],
    warnings = [],
    scanned = new Set(),
    blobIds = new Set();
  findings.push(
    ...(await scanner.scan(Buffer.from(refRows.join("\n")), "ref-metadata.txt", "refs")),
  );
  for (const ref of refs)
    if (ref.type === "tag")
      findings.push(
        ...(await scanner.scan(
          git(root, ["cat-file", "tag", ref.object_id], true),
          "tag-metadata.txt",
          "tag",
          ref.object_id,
        )),
      );
  for (const commit of commits) {
    const content = git(root, ["cat-file", "commit", commit], true);
    findings.push(...(await scanner.scan(content, "commit-metadata.txt", "commit", commit)));
    for (const line of content.toString("utf8").split("\n")) {
      if (!/^(author|committer) /.test(line)) continue;
      const email = /<([^<>]+)>/.exec(line)?.[1];
      if (
        !email ||
        (!email.endsWith("@users.noreply.github.com") && email !== "noreply@github.com")
      )
        warnings.push({ object_id: commit, category: "noncanonical_author_identity" });
    }
    for (const entry of git(root, ["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean)) {
      const match = /^([0-9]+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Incomplete history tree inventory");
      const [, mode, type, objectId, path] = match;
      const identity = `${mode}/${objectId}/${path}`;
      if (scanned.has(identity)) continue;
      scanned.add(identity);
      if (type !== "blob" || !["100644", "100755"].includes(mode)) {
        findings.push({
          kind: "history",
          object_id: objectId,
          location_digest: locationDigest(path),
          category: "unsupported_history_entry",
        });
        continue;
      }
      blobIds.add(objectId);
      const size = Number(git(root, ["cat-file", "-s", objectId]).trim());
      findings.push(
        ...(await scanner.scan(
          size > maximumBytes
            ? Buffer.alloc(maximumBytes + 1)
            : git(root, ["cat-file", "blob", objectId], true),
          path,
          "history",
          objectId,
        )),
      );
    }
  }
  if (
    git(root, ["rev-parse", "HEAD"]).trim() !== head ||
    git(root, ["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)"])
      .trim()
      .split("\n")
      .filter(Boolean)
      .join("\n") !== refRows.join("\n")
  )
    throw new Error("History references changed during audit");
  return {
    schema_version: "public-audit/1",
    scope: "reachable_git_history",
    observed_at: new Date().toISOString(),
    head,
    refs,
    commits: commits.length,
    blob_path_versions: scanned.size,
    unique_blobs: blobIds.size,
    scanned_bytes: scanner.bytes(),
    findings,
    metadata_warnings: warnings,
    passed: findings.length === 0,
  };
}
