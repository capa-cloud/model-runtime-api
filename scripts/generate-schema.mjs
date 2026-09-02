import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executionRequestSchema } from "../packages/protocol/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "spec/schema/execution-request.json");
const raw = `${JSON.stringify(executionRequestSchema, null, 2)}\n`;
const content = execFileSync("pnpm", ["exec", "biome", "format", "--stdin-file-path", output], {
  input: raw,
  encoding: "utf8",
});

if (process.argv.includes("--check")) {
  const existing = await readFile(output, "utf8").catch(() => "");
  if (existing !== content) {
    process.stderr.write(
      "Generated execution request schema is stale. Run pnpm generate:schema.\n",
    );
    process.exit(1);
  }
  process.stdout.write("Generated execution request schema is current.\n");
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content);
  process.stdout.write(`${output}\n`);
}
