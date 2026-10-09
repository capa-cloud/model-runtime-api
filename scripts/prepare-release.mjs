try {
  if (process.env.DEBUG || process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE)
    throw new Error("Unsafe diagnostic environment");
  const { prepareSourceRelease, verifySourceRelease } = await import("./source-release.mjs");
  const { loadPrivatePolicy } = await import("./public-audit.mjs");
  const [mode, commit, directory, ...extra] = process.argv.slice(2);
  if (!["prepare", "verify"].includes(mode) || !commit || !directory || extra.length)
    throw new Error("Invalid release arguments");
  const root = process.cwd();
  const literals = await loadPrivatePolicy(root, process.env.PUBLIC_SCAN_PRIVATE_POLICY);
  const result =
    mode === "prepare"
      ? {
          directory: await prepareSourceRelease(root, commit, directory, literals),
          published: false,
        }
      : await verifySourceRelease(root, commit, directory, literals);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(
    "Source release preparation/verification failed; no publication claim is available.\n",
  );
  process.exitCode = 1;
}
