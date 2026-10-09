import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  buildSourceRelease,
  prepareSourceRelease,
  verifySourceRelease,
} from "./source-release.mjs";

const directories = [];
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TEMPLATE_DIR: "",
};
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
function command(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function commit(root) {
  command(root, ["add", "."]);
  command(root, [
    "-c",
    "user.name=fixture-builder",
    "-c",
    "user.email=fixture@users.noreply.github.com",
    "commit",
    "-m",
    "synthetic fixture",
  ]);
  return command(root, ["rev-parse", "HEAD"]);
}
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "source-release-test-"));
  directories.push(parent);
  const root = join(parent, "repo");
  await mkdir(root);
  command(root, ["init", "--initial-branch=main"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "model-runtime-api" }));
  await writeFile(join(root, "LICENSE"), "Public synthetic license fixture\n");
  await writeFile(join(root, "README.md"), "Public synthetic source\n");
  return { root, parent, sha: commit(root) };
}

test("source bytes reproduce independently of dirty and untracked working files", async () => {
  const { root, parent, sha } = await fixture();
  const first = await buildSourceRelease(root, sha);
  await writeFile(join(root, "README.md"), "uncommitted changes");
  await writeFile(join(root, "private.txt"), "excluded working file");
  const second = await buildSourceRelease(root, sha);
  assert.deepEqual(second, first);
  const manifest = JSON.parse(first.manifest);
  assert.equal(manifest.commit, sha);
  assert.equal(manifest.files.length, 3);
  assert.equal(
    manifest.files.some((file) => file.path === "private.txt"),
    false,
  );
  const output = await prepareSourceRelease(root, sha, parent);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, "source-manifest.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await verifySourceRelease(root, sha, output), {
    passed: true,
    commit: sha,
    files: 3,
  });
});

for (const name of ["model-runtime-api-source.tar.gz", "source-manifest.json", "SHA256SUMS"]) {
  test(`modified ${name} is rejected`, async () => {
    const { root, parent, sha } = await fixture();
    const output = await prepareSourceRelease(root, sha, parent);
    const path = join(output, name);
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("tampered")]));
    await assert.rejects(verifySourceRelease(root, sha, output), /bytes differ/);
  });
}

test("artifact symlinks and additional files are refused", async () => {
  const { root, parent, sha } = await fixture();
  const output = await prepareSourceRelease(root, sha, parent);
  await writeFile(join(output, "extra.txt"), "synthetic");
  await assert.rejects(verifySourceRelease(root, sha, output), /Unexpected release files/);
  await rm(join(output, "extra.txt"));
  const archive = join(output, "model-runtime-api-source.tar.gz");
  await rm(archive);
  await symlink(join(root, "README.md"), archive);
  await assert.rejects(verifySourceRelease(root, sha, output));
  const alias = join(parent, "alias");
  await symlink(output, alias);
  await assert.rejects(verifySourceRelease(root, sha, alias), /Invalid release directory/);
});

test("mutable refs, wrong project identity and in-repository output are refused", async () => {
  const { root, sha } = await fixture();
  await assert.rejects(buildSourceRelease(root, "HEAD"), /full commit SHA/);
  await assert.rejects(prepareSourceRelease(root, sha, root), /outside/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "other-project" }));
  await assert.rejects(buildSourceRelease(root, commit(root)), /Wrong release project/);
});

test("committed secrets and external private markers block artifact generation", async () => {
  const { root } = await fixture();
  const token = ["ghp", "_", "A".repeat(36)].join("");
  await writeFile(join(root, "value.txt"), token);
  await assert.rejects(buildSourceRelease(root, commit(root)), (error) => {
    assert.match(error.message, /source audit failed/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  await writeFile(join(root, "value.txt"), "synthetic-private-marker");
  await assert.rejects(
    buildSourceRelease(root, commit(root), ["synthetic-private-marker"]),
    /source audit failed/,
  );
});

test("committed generated outputs and symbolic links are refused", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "index.js"), "public synthetic output");
  await assert.rejects(buildSourceRelease(root, commit(root)), /generated release path/);
  command(root, ["rm", "-r", "dist"]);
  await symlink("README.md", join(root, "alias"));
  await assert.rejects(buildSourceRelease(root, commit(root)), /regular files only/);
});

test("archive attributes cannot silently omit or substitute audited source", async () => {
  const { root, sha } = await fixture();
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await writeFile(join(root, ".git", "info", "attributes"), "README.md export-ignore\n");
  await assert.rejects(buildSourceRelease(root, sha), /omitted audited files/);
  await writeFile(join(root, ".git", "info", "attributes"), "README.md export-subst\n");
  await writeFile(join(root, "README.md"), "$Format:%H$\n");
  await assert.rejects(buildSourceRelease(root, commit(root)), /does not match/);
  await writeFile(join(root, ".gitattributes"), "README.md export-ignore\n");
  await assert.rejects(buildSourceRelease(root, commit(root)), /release path/);
});
