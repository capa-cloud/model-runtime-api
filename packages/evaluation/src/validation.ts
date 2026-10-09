import { createHash } from "node:crypto";
import { validateExecutionRequest } from "@model-runtime/protocol";
import type { EvaluationSuite, EvaluationCheck, CaseEvidence, EvaluationReport } from "./types.js";

export function invalid(): never {
  throw new Error("Invalid evaluation data");
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid();
  return record;
}
export function label(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) invalid();
  return value;
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    invalid();
  return value as number;
}
export function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${Array.from(value)
      .map((item) => canonicalJson(item, depth + 1))
      .join(",")}]`;
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`,
    )
    .join(",")}}`;
}
export function evaluationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseEvaluationSuite(value: unknown): EvaluationSuite {
  try {
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > 1024 * 1024) invalid();
    const suite = object(JSON.parse(encoded), [
      "schema_version",
      "id",
      "case_timeout_ms",
      "run_timeout_ms",
      "repetitions",
      "cases",
    ]);
    if (suite.schema_version !== "evaluation/1") invalid();
    label(suite.id);
    integer(suite.case_timeout_ms, 1, 60000);
    integer(suite.run_timeout_ms, 1, 600000);
    integer(suite.repetitions, 1, 5);
    if (
      !Array.isArray(suite.cases) ||
      suite.cases.length < 1 ||
      suite.cases.length * (suite.repetitions as number) > 100
    )
      invalid();
    const ids = new Set<string>();
    for (const value of suite.cases) {
      const item = object(value, ["id", "scenario", "request", "checks"]);
      const id = label(item.id);
      label(item.scenario);
      if (ids.has(id)) invalid();
      ids.add(id);
      if (!validateExecutionRequest(item.request).valid) invalid();
      const request = item.request as Record<string, unknown>;
      if (request.routing !== undefined || request.deadline_ms !== undefined) invalid();
      if (!Array.isArray(item.checks) || item.checks.length < 1 || item.checks.length > 32)
        invalid();
      for (const value of item.checks) {
        const check = object(value, [
          "kind",
          "value",
          "output_index",
          "name",
          "arguments",
          "minimum",
        ]);
        const keys = Object.keys(check);
        if (
          check.kind === "text_equals" ||
          check.kind === "text_contains" ||
          check.kind === "json_equals"
        ) {
          if (
            keys.some((key) => !["kind", "value", "output_index"].includes(key)) ||
            !("value" in check)
          )
            invalid();
          if (check.kind !== "json_equals" && typeof check.value !== "string") invalid();
          if (check.kind === "text_contains" && check.value === "") invalid();
          if (check.output_index !== undefined) integer(check.output_index, 0, 4095);
        } else if (check.kind === "tool_call") {
          if (keys.some((key) => !["kind", "name", "arguments"].includes(key))) invalid();
          label(check.name);
        } else if (check.kind === "result_equals") {
          if (keys.some((key) => !["kind", "value"].includes(key)) || !("value" in check))
            invalid();
        } else if (check.kind === "artifact_count") {
          if (keys.some((key) => !["kind", "minimum"].includes(key))) invalid();
          integer(check.minimum, 1, 1024);
        } else invalid();
      }
    }
    return suite as unknown as EvaluationSuite;
  } catch {
    invalid();
  }
}

export function metricsFor(cases: CaseEvidence[]): EvaluationReport["metrics"] {
  const scenarios = [...new Set(cases.map((item) => item.scenario))].sort();
  return scenarios.map((scenario) => {
    const rows = cases.filter((item) => item.scenario === scenario);
    const completed = rows.filter((item) => ["passed", "assertion_failed"].includes(item.status));
    const latencies = completed.map((item) => item.latency_ms!).sort((a, b) => a - b);
    const passed = rows.filter((item) => item.status === "passed").length;
    return {
      scenario,
      sample_count: rows.length,
      passed_count: passed,
      completed_count: completed.length,
      pass_rate: passed / rows.length,
      completion_rate: completed.length / rows.length,
      p50_latency_ms: latencies.length ? latencies[Math.ceil(latencies.length / 2) - 1]! : null,
    };
  });
}

export function parseEvaluationReport(
  value: unknown,
  suiteInput: EvaluationSuite,
): EvaluationReport {
  try {
    const suite = parseEvaluationSuite(suiteInput);
    const report = object(value, [
      "schema_version",
      "evaluator_version",
      "run_id",
      "observed_at",
      "suite_id",
      "suite_digest",
      "configuration_digest",
      "context_id",
      "evidence_kind",
      "environment",
      "candidate",
      "complete",
      "cases",
      "metrics",
      "digest",
    ]);
    const { digest, ...body } = report;
    if (
      Buffer.byteLength(canonicalJson(value)) > 1024 * 1024 ||
      digest !== evaluationDigest(body) ||
      report.schema_version !== "evaluation-report/1" ||
      report.evaluator_version !== "1" ||
      report.suite_id !== suite.id ||
      report.suite_digest !== evaluationDigest(suite)
    )
      invalid();
    hash(report.configuration_digest);
    const environment = object(report.environment, ["node_major", "platform", "architecture"]);
    integer(environment.node_major, 22, 1000);
    label(environment.platform);
    label(environment.architecture);
    label(report.context_id);
    if (
      !["fixture", "live"].includes(String(report.evidence_kind)) ||
      typeof report.complete !== "boolean" ||
      typeof report.run_id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(report.run_id) ||
      typeof report.observed_at !== "string" ||
      new Date(report.observed_at).toISOString() !== report.observed_at
    )
      invalid();
    const candidate = object(report.candidate, ["provider", "model", "manifest_digest"]);
    for (const key of ["provider", "model"])
      if (
        typeof candidate[key] !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(candidate[key] as string)
      )
        invalid();
    hash(candidate.manifest_digest);
    if (
      !Array.isArray(report.cases) ||
      report.cases.length !== suite.cases.length * suite.repetitions
    )
      invalid();
    const seen = new Set<string>();
    for (const value of report.cases) {
      const row = object(value, [
        "case_id",
        "scenario",
        "repetition",
        "status",
        "latency_ms",
        "error_code",
        "checks",
      ]);
      const item = suite.cases.find((item) => item.id === row.case_id);
      if (!item || row.scenario !== item.scenario) invalid();
      integer(row.repetition, 1, suite.repetitions);
      const key = `${row.case_id}/${row.repetition}`;
      if (seen.has(key)) invalid();
      seen.add(key);
      if (
        ![
          "passed",
          "assertion_failed",
          "execution_failed",
          "unsupported",
          "evaluator_failed",
          "not_run",
        ].includes(String(row.status))
      )
        invalid();
      if (row.status === "execution_failed" || row.status === "unsupported") {
        if (
          ![
            "invalid_request",
            "capability_unavailable",
            "queue_full",
            "rate_limited",
            "deadline_exceeded",
            "cancelled",
            "provider_unavailable",
            "provider_protocol_error",
            "internal_error",
          ].includes(String(row.error_code)) ||
          (row.status === "unsupported") !== (row.error_code === "capability_unavailable")
        )
          invalid();
      } else if (row.error_code !== undefined) invalid();
      if (
        row.status === "not_run"
          ? row.latency_ms !== null
          : typeof row.latency_ms !== "number" ||
            !Number.isFinite(row.latency_ms) ||
            row.latency_ms < 0
      )
        invalid();
      if (!Array.isArray(row.checks) || row.checks.length !== item.checks.length) invalid();
      row.checks.forEach((value, index) => {
        const check = object(value, ["kind", "passed"]);
        if (check.kind !== item.checks[index]?.kind || typeof check.passed !== "boolean") invalid();
      });
      const flags = (row.checks as { passed: boolean }[]).map((check) => check.passed);
      if (
        (row.status === "passed" && flags.some((flag) => !flag)) ||
        (row.status === "assertion_failed" && flags.every(Boolean)) ||
        (!["passed", "assertion_failed"].includes(String(row.status)) && flags.some(Boolean))
      )
        invalid();
    }
    const cases = report.cases as CaseEvidence[];
    if (
      report.complete !==
        !cases.some((row) => ["not_run", "evaluator_failed"].includes(row.status)) ||
      canonicalJson(report.metrics) !== canonicalJson(metricsFor(cases))
    )
      invalid();
    return structuredClone(value) as EvaluationReport;
  } catch {
    invalid();
  }
}
