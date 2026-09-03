import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

const findings = [];
for (const file of files.filter((value) => value.endsWith(".md") && existsSync(value))) {
  const content = readFileSync(file, "utf8");
  const targets = [
    ...[...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]),
    ...[...content.matchAll(/\bsrc="([^"]+)"/g)].map((match) => match[1]),
  ];
  for (const targetValue of targets) {
    const target = targetValue?.trim();
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const path = decodeURIComponent(target.split("#", 1)[0] ?? "");
    if (path && !existsSync(resolve(dirname(file), path)))
      findings.push(`${file}: missing ${target}`);
  }
}

const media = files.filter((file) => /^docs\/assets\/[^/]+\.(?:jpg|jpeg|png|webp)$/i.test(file));
let mediaBytes = 0;
for (const file of media) {
  const bytes = statSync(file).size;
  mediaBytes += bytes;
  if (bytes > 512 * 1024) findings.push(`${file}: exceeds the 512 KiB documentation limit`);
  const sidecar = file.replace(/\.(?:jpg|jpeg|png|webp)$/i, ".prompt.md");
  if (!existsSync(sidecar)) findings.push(`${file}: missing prompt/provenance sidecar`);
}
if (mediaBytes > 2 * 1024 * 1024) findings.push("docs/assets: total bitmap size exceeds 2 MiB");

const openapi = parse(readFileSync("spec/openapi.yaml", "utf8"));
if (openapi?.openapi !== "3.1.0") findings.push("spec/openapi.yaml: expected OpenAPI 3.1.0");
for (const path of [
  "/v1/runtime",
  "/v1/providers",
  "/v1/executions",
  "/v1/executions/{executionId}",
  "/v1/executions/{executionId}/events",
  "/v1/executions/{executionId}/result",
  "/v1/executions/{executionId}/cancel",
]) {
  if (!openapi?.paths?.[path]) findings.push(`spec/openapi.yaml: missing ${path}`);
}

if (findings.length) {
  process.stderr.write(`Documentation check failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Documentation links, OpenAPI surface, and ${media.length} optimized media assets passed.\n`,
);
