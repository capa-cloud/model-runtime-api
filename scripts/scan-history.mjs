try {
  if (process.env.DEBUG || process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE)
    throw new Error("Unsafe diagnostic environment");
  const { auditHistory, loadPrivatePolicy } = await import("./public-audit.mjs");
  const root = process.cwd();
  const result = await auditHistory(
    root,
    await loadPrivatePolicy(root, process.env.PUBLIC_SCAN_PRIVATE_POLICY),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.passed ? 0 : 1;
} catch {
  process.stderr.write("History audit could not complete; no clean-history claim is available.\n");
  process.exitCode = 2;
}
