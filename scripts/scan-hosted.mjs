try {
  if (process.env.DEBUG || process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE)
    throw new Error("Unsafe diagnostic environment");
  const { loadPrivatePolicy } = await import("./public-audit.mjs");
  const { auditHostedMetadata } = await import("./hosted-audit.mjs");
  const repository = process.argv[2];
  if (!repository || process.argv.length !== 3)
    throw new Error("An exact repository argument is required");
  const root = process.cwd();
  const result = await auditHostedMetadata(
    root,
    repository,
    await loadPrivatePolicy(root, process.env.PUBLIC_SCAN_PRIVATE_POLICY),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.passed ? 0 : 1;
} catch {
  process.stderr.write(
    "Hosted audit could not complete; verify authorization, repository scope, surfaces and complete pagination.\n",
  );
  process.exitCode = 2;
}
