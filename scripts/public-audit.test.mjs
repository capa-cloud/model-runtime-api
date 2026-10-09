import { execFileSync, execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { auditHistory, auditWorktree, createScanner, loadPrivatePolicy } from "./public-audit.mjs";
import { auditHostedMetadata } from "./hosted-audit.mjs";

const directories = [];
const execute = promisify(execFile);
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TEMPLATE_DIR: "",
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function command(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "public-audit-test-"));
  directories.push(root);
  command(root, ["init", "--initial-branch=main"]);
  await writeFile(join(root, "README.md"), "Public synthetic fixture\n");
  command(root, ["add", "."]);
  commit(root);
  return root;
}
function commit(root) {
  command(root, [
    "-c",
    "user.name=fixture-builder",
    "-c",
    "user.email=fixture@users.noreply.github.com",
    "commit",
    "-m",
    "synthetic fixture",
  ]);
}
const token = () => ["ghp", "_", "A".repeat(36)].join("");

test("a clean index/worktree and complete synthetic history pass", async () => {
  const root = await repository();
  assert.equal((await auditWorktree(root)).passed, true);
  const history = await auditHistory(root);
  assert.equal(history.passed, true);
  assert.equal(history.commits, 1);
  assert.equal(history.unique_blobs, 1);
  assert.equal(history.metadata_warnings.length, 0);
});

test("staged content is scanned even after the working file was cleaned", async () => {
  const root = await repository();
  await writeFile(join(root, "value.txt"), token());
  command(root, ["add", "value.txt"]);
  await writeFile(join(root, "value.txt"), "public placeholder");
  const result = await auditWorktree(root);
  assert.equal(result.passed, false);
  assert.ok(
    result.findings.some(
      (finding) => finding.kind === "index" && finding.category === "secretlint",
    ),
  );
  assert.ok(!JSON.stringify(result).includes(token()));
  assert.ok(!JSON.stringify(result).includes("value.txt"));
});

test("deleted secrets remain detectable in reachable historical blobs", async () => {
  const root = await repository();
  await writeFile(join(root, "deleted.txt"), token());
  command(root, ["add", "."]);
  commit(root);
  command(root, ["rm", "deleted.txt"]);
  commit(root);
  assert.equal((await auditWorktree(root)).passed, true);
  const history = await auditHistory(root);
  assert.equal(history.passed, false);
  assert.ok(history.findings.some((finding) => finding.category === "secretlint"));
  assert.ok(!JSON.stringify(history).includes(token()));
});

test("a value beyond the former one-MiB limit is inspected, not silently skipped", async () => {
  const root = await repository();
  await writeFile(join(root, "large.txt"), `${"x".repeat(1024 * 1024 + 1)}\n${token()}`);
  const result = await auditWorktree(root);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((finding) => finding.category === "credential_token"));
});

test("oversized files, missing tracked files and symlinks fail closed", async () => {
  const root = await repository();
  await writeFile(join(root, "large.txt"), "x".repeat(8 * 1024 * 1024 + 1));
  await symlink("README.md", join(root, "alias"));
  await rm(join(root, "README.md"));
  const result = await auditWorktree(root);
  assert.equal(result.passed, false);
  assert.equal(
    result.findings.filter((finding) => finding.category === "unreadable_or_oversized_file").length,
    3,
  );
});

test("dangerous filenames and control-character names are detected without leaking paths", async () => {
  const root = await repository();
  await writeFile(join(root, ".env"), "synthetic placeholder");
  await writeFile(join(root, "control\nname.txt"), "public placeholder");
  const result = await auditWorktree(root);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((finding) => finding.category === "dangerous_file"));
  assert.ok(result.findings.some((finding) => finding.category === "unsafe_filename"));
  assert.ok(!JSON.stringify(result).includes("control"));
});

test("private policies must be external and literal matches never echo their values", async () => {
  const root = await repository();
  const parent = await mkdtemp(join(tmpdir(), "private-policy-test-"));
  directories.push(parent);
  const value = { literals: ["synthetic-organization-marker"] };
  await writeFile(join(parent, "policy.json"), JSON.stringify(value));
  const literals = await loadPrivatePolicy(root, join(parent, "policy.json"));
  const scanner = await createScanner(root, literals);
  const findings = await scanner.scan(
    Buffer.from(value.literals[0].toUpperCase()),
    "metadata.txt",
    "fixture",
  );
  assert.ok(findings.some((finding) => finding.category === "private_literal"));
  assert.ok(!JSON.stringify(findings).includes(value.literals[0]));
  await writeFile(join(root, "..policy.json"), JSON.stringify(value));
  await assert.rejects(loadPrivatePolicy(root, join(root, "..policy.json")), /outside/);
});

test("annotated tag and ref metadata are inspected", async () => {
  const root = await repository();
  command(root, [
    "-c",
    "user.name=fixture-builder",
    "-c",
    "user.email=fixture@users.noreply.github.com",
    "tag",
    "-a",
    "fixture-tag",
    "-m",
    "synthetic-organization-marker",
  ]);
  const result = await auditHistory(root, ["synthetic-organization-marker"]);
  assert.equal(result.passed, false);
  assert.ok(
    result.findings.some(
      (finding) => finding.kind === "tag" && finding.category === "private_literal",
    ),
  );
});

test("shallow history is refused rather than reported clean", async () => {
  const root = await repository();
  const parent = await mkdtemp(join(tmpdir(), "shallow-audit-test-"));
  directories.push(parent);
  const target = join(parent, "clone");
  command(parent, ["clone", "--depth=1", `file://${root}`, target]);
  await assert.rejects(auditHistory(target), /Complete history/);
});

test("a changed ref inventory invalidates a running history audit", async () => {
  const root = await repository();
  const pending = auditHistory(root);
  command(root, ["branch", "fixture-new-reference"]);
  await assert.rejects(pending, /references changed/);
});

test("a changing index cannot receive a clean publication result", async () => {
  const root = await repository();
  const pending = auditWorktree(root);
  await writeFile(join(root, "later.txt"), "synthetic placeholder");
  command(root, ["add", "later.txt"]);
  await assert.rejects(pending, /Index changed/);
});

test("CLI fatal diagnostics contain no supplied paths or parser content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "audit-cli-test-"));
  directories.push(directory);
  const target = resolve("scripts/scan-history.mjs");
  try {
    await execute(process.execPath, [target], { cwd: directory, env, timeout: 5000 });
    assert.fail("expected refusal");
  } catch (error) {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    assert.ok(error.stderr.includes("could not complete"));
    assert.ok(!error.stderr.includes(directory));
  }
});

test("CLI rejects debug logging before loading detectors or processing private inputs", async () => {
  const root = await repository();
  try {
    await execute(process.execPath, [resolve("scripts/scan-public.mjs")], {
      cwd: root,
      env: { ...env, DEBUG: "*" },
      timeout: 5000,
    });
    assert.fail("expected refusal");
  } catch (error) {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    assert.ok(error.stderr.includes("could not complete"));
    assert.ok(!error.stderr.includes(root));
  }
});

test("UTF-16 values are decoded and opaque artifacts require separate review", async () => {
  const root = await repository();
  await writeFile(
    join(root, "encoded.txt"),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from(token(), "utf16le")]),
  );
  await writeFile(join(root, "archive.zip"), "synthetic archive placeholder");
  const result = await auditWorktree(root);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((finding) => finding.category === "secretlint"));
  assert.ok(
    result.findings.some((finding) => finding.category === "opaque_artifact_requires_review"),
  );
});

test("hosted metadata includes overall review bodies and excludes matched values", async () => {
  const root = await repository();
  const repositoryName = "fixture-owner/public-example";
  const api = async (path) => {
    if (path === `repos/${repositoryName}`)
      return { default_branch: "main", has_wiki: false, has_discussions: false };
    if (path.includes("/commits/")) return { sha: "a".repeat(40) };
    if (path.includes("/issues?")) return [[{ number: 1, pull_request: {}, body: "synthetic" }]];
    if (path.includes("/reviews?")) return [[{ body: token() }]];
    return [[]];
  };
  const result = await auditHostedMetadata(root, repositoryName, [], api);
  assert.equal(result.passed, false);
  assert.equal(result.counts.reviews, 1);
  assert.ok(result.findings.some((finding) => finding.kind === "hosted_reviews"));
  assert.ok(!JSON.stringify(result).includes(token()));
});

test("uncovered hosted assets/surfaces and malformed pagination fail closed", async () => {
  const root = await repository();
  for (const option of ["wiki", "assets", "paging"]) {
    const api = async (path) => {
      if (path === "repos/fixture-owner/public-example")
        return { default_branch: "main", has_wiki: option === "wiki", has_discussions: false };
      if (path.includes("/commits/")) return { sha: "a".repeat(40) };
      if (path.includes("/releases?"))
        return option === "assets"
          ? [[{ assets: [{ name: "synthetic" }] }]]
          : option === "paging"
            ? [null]
            : [[]];
      return [[]];
    };
    await assert.rejects(auditHostedMetadata(root, "fixture-owner/public-example", [], api));
  }
});
