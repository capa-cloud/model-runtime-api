import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]?.trim();
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const path = decodeURIComponent(target.split("#", 1)[0] ?? "");
    if (path && !existsSync(resolve(dirname(file), path)))
      findings.push(`${file}: missing ${target}`);
  }
}

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
process.stdout.write("Documentation links and OpenAPI surface passed.\n");
