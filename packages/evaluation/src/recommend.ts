import { createCatalogSnapshot } from "@model-runtime/catalog";
import { parseEvaluationCatalog, type EvaluationCatalog } from "./profile.js";
import type { EvaluationSuite, EvaluationReport, EvidenceKind } from "./types.js";
import {
  canonicalJson,
  evaluationDigest,
  integer,
  label,
  parseEvaluationReport,
  parseEvaluationSuite,
  invalid,
} from "./validation.js";

export interface RecommendationOptions {
  catalog: EvaluationCatalog;
  contextId: string;
  evidenceKind: EvidenceKind;
  metric?: "pass_rate" | "p50_latency_ms";
  minimumPassRate?: number;
  minimumSamples?: number;
  maxAgeMs?: number;
  now?: number;
}

export function recommendModels(
  suiteInput: EvaluationSuite,
  reportInputs: EvaluationReport[],
  options: RecommendationOptions,
) {
  const suite = parseEvaluationSuite(suiteInput);
  const profile = parseEvaluationCatalog(options.catalog);
  const catalog = profile.catalog;
  const configurations = new Map(
    profile.configurations.map((config) => [
      JSON.stringify([config.provider, config.model]),
      config.configuration_digest,
    ]),
  );
  label(options.contextId);
  const now = options.now ?? Date.now();
  const maxAgeMs = integer(options.maxAgeMs ?? 86400000, 1, 604800000);
  const minimumSamples = integer(options.minimumSamples ?? 5, 1, 100);
  const minimumPassRate = options.minimumPassRate ?? 1;
  const metric = options.metric ?? "pass_rate";
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(minimumPassRate) ||
    minimumPassRate < 0 ||
    minimumPassRate > 1 ||
    !["pass_rate", "p50_latency_ms"].includes(metric) ||
    !["fixture", "live"].includes(options.evidenceKind) ||
    !Array.isArray(reportInputs) ||
    reportInputs.length > 64
  )
    invalid();
  const freshness = (observed: string) =>
    Date.parse(observed) <= now && now - Date.parse(observed) <= maxAgeMs;
  if (!freshness(catalog.observed_at)) throw new Error("A fresh current catalog is required");
  const manifests = new Map<string, string>();
  for (const provider of catalog.providers)
    for (const model of provider.models) {
      const individual = createCatalogSnapshot([{ ...provider, models: [model] }]);
      manifests.set(JSON.stringify([provider.provider, model.model]), individual.digest);
    }
  const reports = reportInputs.map((report) => parseEvaluationReport(report, suite));
  const comparable = reports.filter(
    (report) =>
      report.evidence_kind === options.evidenceKind &&
      report.context_id === options.contextId &&
      report.complete &&
      freshness(report.observed_at) &&
      manifests.get(JSON.stringify([report.candidate.provider, report.candidate.model])) ===
        report.candidate.manifest_digest &&
      configurations.get(JSON.stringify([report.candidate.provider, report.candidate.model])) ===
        report.configuration_digest,
  );
  if (new Set(comparable.map((report) => canonicalJson(report.environment))).size > 1)
    throw new Error("Evaluation environments must match before ranking");
  const identities = new Set<string>();
  for (const report of reports) {
    const key = JSON.stringify([report.candidate.provider, report.candidate.model]);
    if (identities.has(key))
      throw new Error("Select one evaluation report per candidate before recommendation");
    identities.add(key);
  }
  const scenarios = [...new Set(suite.cases.map((item) => item.scenario))]
    .sort()
    .map((scenario) => {
      const ranking: {
        provider: string;
        model: string;
        pass_rate: number;
        completion_rate: number;
        p50_latency_ms: number | null;
        sample_count: number;
        report_digest: string;
      }[] = [];
      const excluded: { provider: string; model: string; reason: string }[] = [];
      for (const report of reports) {
        const { provider, model, manifest_digest } = report.candidate;
        const facts = report.metrics.find((value) => value.scenario === scenario)!;
        const current = manifests.get(JSON.stringify([provider, model]));
        const reason =
          report.evidence_kind !== options.evidenceKind
            ? "evidence_kind_mismatch"
            : report.context_id !== options.contextId
              ? "context_mismatch"
              : !report.complete
                ? "incomplete_run"
                : !freshness(report.observed_at)
                  ? "stale_or_future_evidence"
                  : !current
                    ? "model_not_in_current_catalog"
                    : current !== manifest_digest
                      ? "capability_changed"
                      : configurations.get(JSON.stringify([provider, model])) !==
                          report.configuration_digest
                        ? "configuration_changed"
                        : report.cases.some(
                              (row) => row.scenario === scenario && row.status === "unsupported",
                            )
                          ? "scenario_capability_unavailable"
                          : !facts.completed_count
                            ? "no_completed_samples"
                            : facts.sample_count < minimumSamples
                              ? "insufficient_samples"
                              : facts.pass_rate < minimumPassRate
                                ? "quality_gate_failed"
                                : metric === "p50_latency_ms" && facts.p50_latency_ms === null
                                  ? "missing_latency"
                                  : undefined;
        if (reason) excluded.push({ provider, model, reason });
        else
          ranking.push({
            provider,
            model,
            pass_rate: facts.pass_rate,
            completion_rate: facts.completion_rate,
            p50_latency_ms: facts.p50_latency_ms,
            sample_count: facts.sample_count,
            report_digest: report.digest,
          });
      }
      ranking.sort(
        (a, b) =>
          (metric === "pass_rate"
            ? b.pass_rate - a.pass_rate
            : a.p50_latency_ms! - b.p50_latency_ms!) ||
          (JSON.stringify([a.provider, a.model]) < JSON.stringify([b.provider, b.model]) ? -1 : 1),
      );
      const best = ranking[0]?.[metric];
      return {
        scenario,
        status: ranking.length ? "recommended" : "insufficient_evidence",
        ranking,
        recommended_models: ranking
          .filter((row) => row[metric] === best)
          .map(({ provider, model }) => ({ provider, model })),
        excluded,
      };
    });
  return {
    schema_version: "recommendation/1",
    observed_at: new Date(now).toISOString(),
    suite_id: suite.id,
    suite_digest: evaluationDigest(suite),
    context_id: options.contextId,
    evidence_kind: options.evidenceKind,
    environment: comparable[0]?.environment ?? null,
    metric,
    policy: {
      minimum_pass_rate: minimumPassRate,
      minimum_samples: minimumSamples,
      max_age_ms: maxAgeMs,
    },
    catalog_digest: profile.digest,
    scenarios,
  };
}
