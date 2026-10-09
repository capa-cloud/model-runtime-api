#!/usr/bin/env node
import { readLocalJson, createCatalogSnapshot } from "@model-runtime/catalog";
import type { ProviderManifest } from "@model-runtime/protocol";
import { runtimeFromConfiguration } from "@model-runtime/server";
import type { ModelRuntime } from "@model-runtime/core";
import {
  parseEvaluationSuite,
  runEvaluation,
  recommendModels,
  evaluationDigest,
  createEvaluationCatalog,
  parseEvaluationCatalog,
  type EvaluationCatalog,
  type EvidenceKind,
  type EvaluationReport,
} from "./index.js";

const [command, ...args] = process.argv.slice(2);
let runtime: ModelRuntime | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let incomplete = false;
const stop = new AbortController();
const interrupt = () => stop.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  if (
    command === "run" &&
    ((args[0] === "fixture" && args.length === 3) || (args[0] === "live" && args.length === 4))
  ) {
    const kind = args[0] as EvidenceKind;
    const suite = parseEvaluationSuite(await readLocalJson(args[1]!));
    const context = args.at(-1)!;
    watchdog = setTimeout(() => {
      process.stderr.write(
        "Evaluation shutdown deadline exceeded; remote outcome may be unknown.\n",
      );
      process.exit(1);
    }, suite.run_timeout_ms + 20000);
    const configuration = await configurationFor(kind, args[2]);
    runtime = await runtimeFromConfiguration(configuration);
    const report = await runEvaluation(runtime, suite, {
      contextId: context,
      configurationDigest: evaluationDigest(configuration),
      evidenceKind: kind,
      signal: stop.signal,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    incomplete = !report.complete;
    if (!report.complete || report.cases.some((row) => row.status !== "passed"))
      process.exitCode = 1;
  } else if (
    command === "catalog" &&
    ((args[0] === "fixture" && args.length === 1) ||
      (args[0] === "live" && args.length >= 2 && args.length <= 65))
  ) {
    const kind = args[0] as EvidenceKind;
    const manifests: ProviderManifest[] = [];
    const configurations: EvaluationCatalog["configurations"] = [];
    for (const path of kind === "fixture" ? [undefined] : args.slice(1)) {
      const config = await configurationFor(kind, path);
      runtime = await runtimeFromConfiguration(config);
      const snapshot = createCatalogSnapshot(await runtime.manifests());
      if (snapshot.providers.length !== 1 || snapshot.providers[0]!.models.length !== 1)
        throw new Error("An isolated configuration is required");
      const provider = snapshot.providers[0]!;
      manifests.push(provider);
      configurations.push({
        provider: provider.provider,
        model: provider.models[0]!.model,
        configuration_digest: evaluationDigest(config),
      });
      await runtime.close();
      runtime = undefined;
    }
    process.stdout.write(
      `${JSON.stringify(createEvaluationCatalog(createCatalogSnapshot(manifests), configurations), null, 2)}\n`,
    );
  } else if (
    command === "recommend" &&
    args.length >= 6 &&
    ["fixture", "live"].includes(args[0]!) &&
    ["pass_rate", "p50_latency_ms"].includes(args[4]!)
  ) {
    const suite = parseEvaluationSuite(await readLocalJson(args[1]!));
    const catalog = parseEvaluationCatalog(await readLocalJson(args[2]!));
    const reports: EvaluationReport[] = [];
    if (args.length > 69) throw new Error("Too many evaluation inputs");
    for (const path of args.slice(5)) reports.push((await readLocalJson(path)) as EvaluationReport);
    const result = recommendModels(suite, reports, {
      catalog,
      evidenceKind: args[0] as EvidenceKind,
      contextId: args[3]!,
      metric: args[4] as "pass_rate" | "p50_latency_ms",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else usage();
} catch {
  process.stderr.write(
    "Evaluation operation failed; verify isolated configuration, suite/report integrity, source freshness and required environment variables.\n",
  );
  process.exitCode = 1;
} finally {
  try {
    await runtime?.close();
  } catch {
    process.stderr.write("Evaluation cleanup failed; remote outcome may be unknown.\n");
    process.exitCode = 1;
    incomplete = true;
  }
  if (watchdog) clearTimeout(watchdog);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (incomplete) process.exit(1);
}

function usage(): never {
  process.stderr.write(
    "Usage:\n  model-runtime-evaluate run fixture SUITE.json CONTEXT\n  model-runtime-evaluate run live SUITE.json CONFIG.json CONTEXT\n  model-runtime-evaluate catalog fixture\n  model-runtime-evaluate catalog live CONFIG.json...\n  model-runtime-evaluate recommend fixture|live SUITE.json CATALOG.json CONTEXT pass_rate|p50_latency_ms REPORT.json...\n",
  );
  process.exit(2);
}

async function configurationFor(kind: EvidenceKind, path?: string): Promise<unknown> {
  const configuration =
    kind === "fixture" ? { providers: [{ type: "mock" }] } : await readLocalJson(path!);
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
    throw new Error("Invalid evaluation configuration");
  const config = configuration as Record<string, unknown>;
  if (
    config.event_store !== undefined ||
    !Array.isArray(config.providers) ||
    config.providers.length !== 1 ||
    (kind === "live" && (config.providers[0] as { type?: string })?.type === "mock")
  )
    throw new Error("Evaluation requires a dedicated single-model nonpersistent configuration");
  return configuration;
}
