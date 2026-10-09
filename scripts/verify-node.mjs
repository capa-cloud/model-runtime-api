import { spawnSync } from "node:child_process";

const commands = [
  "format:check",
  "typecheck",
  "test",
  "check:certification",
  "check:public-audit",
  "check:schema",
  "check:docs",
];
for (const command of commands) {
  const result = spawnSync("pnpm", [command], { stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) {
    process.stderr.write(`Node verification failed at ${command}.\n`);
    process.exit(1);
  }
}
process.stdout.write(
  "Node-only verification passed; SDK, root Git disclosure and hosted gates are separate.\n",
);
