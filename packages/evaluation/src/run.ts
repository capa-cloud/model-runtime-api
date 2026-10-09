import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@model-runtime/core";
import { createCatalogSnapshot } from "@model-runtime/catalog";
import type { RuntimeEvent } from "@model-runtime/protocol";
import type {
  EvaluationSuite,
  EvaluationReport,
  EvaluationCase,
  CaseEvidence,
  EvaluationCheck,
  EvidenceKind,
} from "./types.js";
import {
  canonicalJson,
  evaluationDigest,
  hash,
  integer,
  label,
  metricsFor,
  parseEvaluationSuite,
  parseEvaluationReport,
  invalid,
} from "./validation.js";

export interface EvaluationOptions {
  contextId: string;
  configurationDigest: string;
  evidenceKind: EvidenceKind;
  signal?: AbortSignal;
}
class EvaluationStop extends Error {}

export async function runEvaluation(
  runtime: ModelRuntime,
  suiteInput: EvaluationSuite,
  options: EvaluationOptions,
): Promise<EvaluationReport> {
  try {
    return await evaluate(runtime, suiteInput, options);
  } catch (error) {
    throw new Error(
      error instanceof EvaluationStop
        ? error.message
        : "Evaluation failed before a verified report was available",
    );
  }
}

async function evaluate(
  runtime: ModelRuntime,
  suiteInput: EvaluationSuite,
  options: EvaluationOptions,
): Promise<EvaluationReport> {
  const suite = parseEvaluationSuite(suiteInput);
  label(options.contextId);
  hash(options.configurationDigest);
  if (!["fixture", "live"].includes(options.evidenceKind)) invalid();
  const end = performance.now() + suite.run_timeout_ms;
  const catalog = createCatalogSnapshot(await bounded(runtime.manifests(), end, options.signal));
  if (catalog.providers.length !== 1 || catalog.providers[0]!.models.length !== 1)
    throw new EvaluationStop(
      "Evaluation requires an isolated single-provider single-model runtime",
    );
  const provider = catalog.providers[0]!;
  const candidate = {
    provider: provider.provider,
    model: provider.models[0]!.model,
    manifest_digest: catalog.digest,
  };
  const rows: CaseEvidence[] = [];
  let stopped = false;
  for (let repetition = 1; repetition <= suite.repetitions; repetition++) {
    for (const item of suite.cases) {
      if (stopped || options.signal?.aborted || performance.now() >= end) {
        rows.push(evidence(item, repetition, "not_run", null));
        continue;
      }
      const row = await runCase(runtime, item, repetition, candidate, suite, end, options.signal);
      rows.push(row);
      if (row.status === "evaluator_failed") stopped = true;
    }
  }
  const body: Omit<EvaluationReport, "digest"> = {
    schema_version: "evaluation-report/1",
    evaluator_version: "1",
    run_id: randomUUID(),
    observed_at: new Date().toISOString(),
    suite_id: suite.id,
    suite_digest: evaluationDigest(suite),
    configuration_digest: options.configurationDigest,
    context_id: options.contextId,
    evidence_kind: options.evidenceKind,
    environment: {
      node_major: Number(process.versions.node.split(".")[0]),
      platform: process.platform,
      architecture: process.arch,
    },
    candidate,
    complete: !rows.some((row) => ["not_run", "evaluator_failed"].includes(row.status)),
    cases: rows,
    metrics: metricsFor(rows),
  };
  return parseEvaluationReport({ ...body, digest: evaluationDigest(body) }, suite);
}

interface Output {
  texts: Map<number, string>;
  tools: Map<string, { name: string; arguments: string; hasArguments: boolean }>;
  result: unknown;
  hasResult: boolean;
  artifacts: Set<string>;
}
async function runCase(
  runtime: ModelRuntime,
  item: EvaluationCase,
  repetition: number,
  target: EvaluationReport["candidate"],
  suite: EvaluationSuite,
  runEnd: number,
  signal?: AbortSignal,
): Promise<CaseEvidence> {
  const started = performance.now();
  const end = Math.min(runEnd, started + suite.case_timeout_ms + 10000);
  const iterator = runtime.execute({
    ...item.request,
    deadline_ms: suite.case_timeout_ms,
    routing: { allow_fallback: false, max_attempts: 1 },
  });
  const output: Output = {
    texts: new Map(),
    tools: new Map(),
    result: undefined,
    hasResult: false,
    artifacts: new Set(),
  };
  let executionId: string | undefined;
  let terminal = false;
  let count = 0,
    bytes = 0;
  let row: CaseEvidence;
  try {
    while (true) {
      const next = await bounded(iterator.next(), end, signal);
      if (next.done) throw new EvaluationStop("Missing terminal event");
      const event = next.value;
      executionId ??= event.execution_id;
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (++count > 4096 || bytes > 1024 * 1024)
        throw new EvaluationStop("Evaluation output limit exceeded");
      if (
        event.type === "route.selected" &&
        (event.target.provider !== target.provider || event.target.model !== target.model)
      )
        throw new EvaluationStop("Evaluation target changed");
      if (event.type === "execution.completed") {
        if (event.target.provider !== target.provider || event.target.model !== target.model)
          throw new EvaluationStop("Evaluation target changed");
        terminal = true;
        const checks = item.checks.map((check) => ({
          kind: check.kind,
          passed: checkOutput(check, output),
        }));
        row = {
          ...evidence(
            item,
            repetition,
            checks.every((check) => check.passed) ? "passed" : "assertion_failed",
            performance.now() - started,
          ),
          checks,
        };
        break;
      }
      if (event.type === "execution.failed") {
        terminal = true;
        row = evidence(
          item,
          repetition,
          event.error.code === "capability_unavailable" ? "unsupported" : "execution_failed",
          performance.now() - started,
        );
        row.error_code = event.error.code;
        break;
      }
      collect(event, output);
    }
  } catch {
    row = evidence(item, repetition, "evaluator_failed", performance.now() - started);
  } finally {
    if (!terminal && executionId) runtime.cancel(executionId);
    try {
      await bounded(iterator.return(undefined), Math.min(runEnd, performance.now() + 10000));
    } catch {
      terminal = false;
    }
  }
  return terminal
    ? row!
    : evidence(item, repetition, "evaluator_failed", performance.now() - started);
}

function evidence(
  item: EvaluationCase,
  repetition: number,
  status: CaseEvidence["status"],
  latency_ms: number | null,
): CaseEvidence {
  return {
    case_id: item.id,
    scenario: item.scenario,
    repetition,
    status,
    latency_ms,
    checks: item.checks.map((check) => ({ kind: check.kind, passed: false })),
  };
}
function collect(event: RuntimeEvent, output: Output): void {
  if (event.type === "output.delta") {
    integer(event.output_index, 0, 4095);
    if (typeof event.delta !== "string") throw new EvaluationStop("Invalid output delta");
    output.texts.set(
      event.output_index,
      (output.texts.get(event.output_index) ?? "") + event.delta,
    );
  } else if (event.type === "tool.call.started") {
    if (!event.call_id || output.tools.has(event.call_id) || typeof event.name !== "string")
      throw new EvaluationStop("Invalid tool event");
    output.tools.set(event.call_id, { name: event.name, arguments: "", hasArguments: false });
  } else if (event.type === "tool.call.arguments.delta") {
    const tool = output.tools.get(event.call_id);
    if (!tool || typeof event.delta !== "string")
      throw new EvaluationStop("Invalid tool argument event");
    tool.arguments += event.delta;
    tool.hasArguments = true;
  } else if (event.type === "output.result") {
    output.result = event.result;
    output.hasResult = true;
    for (const artifact of event.artifacts ?? [])
      if (typeof artifact.uri === "string" && artifact.uri) output.artifacts.add(artifact.uri);
  }
}
function checkOutput(check: EvaluationCheck, output: Output): boolean {
  try {
    if (
      check.kind === "text_equals" ||
      check.kind === "text_contains" ||
      check.kind === "json_equals"
    ) {
      const index = check.output_index ?? 0;
      if (!output.texts.has(index)) return false;
      const text = output.texts.get(index)!;
      if (check.kind === "text_equals") return text === check.value;
      if (check.kind === "text_contains") return text.includes(check.value);
      return canonicalJson(JSON.parse(text)) === canonicalJson(check.value);
    }
    if (check.kind === "result_equals")
      return output.hasResult && canonicalJson(output.result) === canonicalJson(check.value);
    if (check.kind === "artifact_count") return output.artifacts.size >= check.minimum;
    if (check.kind === "tool_call")
      return [...output.tools.values()].some((tool) => {
        if (tool.name !== check.name) return false;
        if (!("arguments" in check)) return true;
        try {
          return (
            tool.hasArguments &&
            canonicalJson(JSON.parse(tool.arguments)) === canonicalJson(check.arguments)
          );
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
  return false;
}

function bounded<T>(pending: Promise<T>, end: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new EvaluationStop("Evaluation was interrupted"));
    };
    const timer = setTimeout(abort, Math.max(1, end - performance.now()));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || performance.now() >= end) abort();
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
