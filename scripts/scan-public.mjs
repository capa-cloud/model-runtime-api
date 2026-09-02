import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .filter((file) => !file.startsWith("node_modules/") && !file.includes("/dist/"));

const checks = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "credential-like token", pattern: /\b(?:sk|ghp|gho|glpat)-[A-Za-z0-9_-]{12,}\b/ },
  { name: "bearer credential", pattern: /authorization\s*:\s*bearer\s+[A-Za-z0-9._~-]{12,}/i },
  { name: "local absolute path", pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+\// },
  {
    name: "private IPv4 address",
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
  {
    name: "internal-looking domain",
    pattern: /\b[A-Za-z0-9.-]+\.(?:internal|corp|localdomain)\b/i,
  },
];

const findings = [];
for (const file of files) {
  if (file === "scripts/scan-public.mjs" || !existsSync(file) || statSync(file).size > 1024 * 1024)
    continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const check of checks) {
    const match = content.match(check.pattern);
    if (!match || match.index === undefined) continue;
    const line = content.slice(0, match.index).split("\n").length;
    findings.push(`${file}:${line}: ${check.name}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Public-data scan failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Public-data scan passed for ${files.length} files.\n`);
