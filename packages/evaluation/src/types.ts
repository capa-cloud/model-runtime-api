import type { ExecutionRequest, RuntimeErrorCode } from "@model-runtime/protocol";

export type EvidenceKind = "fixture" | "live";
export type EvaluationCheck =
  | { kind: "text_equals" | "text_contains"; value: string; output_index?: number }
  | { kind: "json_equals"; value: unknown; output_index?: number }
  | { kind: "tool_call"; name: string; arguments?: unknown }
  | { kind: "result_equals"; value: unknown }
  | { kind: "artifact_count"; minimum: number };
export interface EvaluationCase {
  id: string;
  scenario: string;
  request: ExecutionRequest;
  checks: EvaluationCheck[];
}
export interface EvaluationSuite {
  schema_version: "evaluation/1";
  id: string;
  case_timeout_ms: number;
  run_timeout_ms: number;
  repetitions: number;
  cases: EvaluationCase[];
}
export type CaseStatus =
  | "passed"
  | "assertion_failed"
  | "execution_failed"
  | "unsupported"
  | "evaluator_failed"
  | "not_run";
export interface CaseEvidence {
  case_id: string;
  scenario: string;
  repetition: number;
  status: CaseStatus;
  latency_ms: number | null;
  error_code?: RuntimeErrorCode;
  checks: { kind: EvaluationCheck["kind"]; passed: boolean }[];
}
export interface ScenarioMetric {
  scenario: string;
  sample_count: number;
  passed_count: number;
  completed_count: number;
  pass_rate: number;
  completion_rate: number;
  p50_latency_ms: number | null;
}
export interface EvaluationReport {
  schema_version: "evaluation-report/1";
  evaluator_version: "1";
  run_id: string;
  observed_at: string;
  suite_id: string;
  suite_digest: string;
  configuration_digest: string;
  context_id: string;
  evidence_kind: EvidenceKind;
  environment: { node_major: number; platform: string; architecture: string };
  candidate: { provider: string; model: string; manifest_digest: string };
  complete: boolean;
  cases: CaseEvidence[];
  metrics: ScenarioMetric[];
  digest: string;
}
