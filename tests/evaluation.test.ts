import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelRuntime,
  type ModelProvider,
  type ProviderExecutionContext,
} from "@model-runtime/core";
import { MockProvider } from "@model-runtime/provider-mock";
import { createCatalogSnapshot } from "@model-runtime/catalog";
import type { ProviderEvent, ProviderManifest } from "@model-runtime/protocol";
import {
  evaluationDigest,
  parseEvaluationSuite,
  parseEvaluationReport,
  runEvaluation,
  recommendModels,
  createEvaluationCatalog,
  parseEvaluationCatalog,
  type EvaluationSuite,
  type EvaluationReport,
  type EvaluationCheck,
} from "@model-runtime/evaluation";

const runtimes: ModelRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});
function runtime(provider: ModelProvider = new MockProvider()) {
  const value = new ModelRuntime();
  value.register(provider);
  runtimes.push(value);
  return value;
}
const options = {
  contextId: "fixture-context",
  configurationDigest: evaluationDigest({ synthetic: true }),
  evidenceKind: "fixture" as const,
};
function currentCatalog(manifests: ProviderManifest[], observedAt?: string) {
  return createEvaluationCatalog(
    createCatalogSnapshot(manifests, observedAt),
    manifests.flatMap((provider) =>
      provider.models.map((model) => ({
        provider: provider.provider,
        model: model.model,
        configuration_digest: options.configurationDigest,
      })),
    ),
  );
}
function suite(
  checks: EvaluationCheck[] = [{ kind: "text_equals", value: "hello from mock" }],
): EvaluationSuite {
  return {
    schema_version: "evaluation/1",
    id: "fixture-suite",
    case_timeout_ms: 1000,
    run_timeout_ms: 10000,
    repetitions: 1,
    cases: [
      {
        id: "case-a",
        scenario: "text",
        request: {
          ability: "text-generation",
          input: [{ type: "text", text: "synthetic-private-prompt" }],
        },
        checks,
      },
    ],
  };
}
async function provider(events: ProviderEvent[]): Promise<ModelProvider> {
  const manifest = await new MockProvider().manifest();
  manifest.models[0]!.tools = true;
  manifest.models[0]!.async = true;
  return {
    id: manifest.provider,
    manifest: async () => structuredClone(manifest),
    async *execute() {
      yield* events;
    },
  };
}
function edited(report: EvaluationReport, edit: (report: EvaluationReport) => void) {
  const value = structuredClone(report);
  edit(value);
  const { digest: _digest, ...body } = value;
  value.digest = evaluationDigest(body);
  return value;
}

describe("bounded scenario evaluation", () => {
  it("bounds and redacts failed or stalled attribution discovery", async () => {
    const mock = new MockProvider();
    mock.manifest = async () => {
      throw new Error("synthetic-private-manifest-error");
    };
    await expect(runEvaluation(runtime(mock), suite(), options)).rejects.toThrow(
      /^Evaluation failed before a verified report was available$/,
    );
    const stalled = new MockProvider();
    stalled.manifest = () => new Promise<ProviderManifest>(() => {});
    const value = suite();
    value.run_timeout_ms = 20;
    await expect(runEvaluation(runtime(stalled), value, options)).rejects.toThrow("interrupted");
  });

  it("bounds the complete job and cancels active work before remaining repetitions", async () => {
    const mock = new MockProvider();
    let closed = false;
    mock.execute = async function* (context: ProviderExecutionContext) {
      try {
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener("abort", () => reject(new Error("synthetic stop")), {
            once: true,
          }),
        );
        yield { type: "execution.completed" };
      } finally {
        closed = true;
      }
    };
    const value = suite();
    value.run_timeout_ms = 100;
    value.repetitions = 2;
    const report = await runEvaluation(runtime(mock), value, options);
    expect(report.complete).toBe(false);
    expect(report.cases[1]?.status).toBe("not_run");
    expect(closed).toBe(true);
  });
  it("runs fresh repetitions and reports only assertion facts with metrics", async () => {
    const value = suite([
      { kind: "text_equals", value: "hello from mock" },
      { kind: "text_contains", value: "mock" },
    ]);
    value.repetitions = 3;
    const engine = runtime();
    const execute = vi.spyOn(engine, "execute");
    const report = await runEvaluation(engine, value, options);
    expect(report.complete).toBe(true);
    expect(report.cases).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(report.metrics[0]).toMatchObject({
      sample_count: 3,
      passed_count: 3,
      completed_count: 3,
      pass_rate: 1,
    });
    expect(report.metrics[0]!.p50_latency_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(report)).not.toMatch(
      /synthetic-private-prompt|hello from mock|input_token|api_key|execution_id/,
    );
    expect(parseEvaluationReport(report, value)).toEqual(report);
  });

  it("compares parsed JSON canonically, including falsy values", async () => {
    for (const value of [{ b: 2, a: 1 }, null, false, 0, ""]) {
      const engine = runtime(new MockProvider({ chunks: [JSON.stringify(value)] }));
      const report = await runEvaluation(engine, suite([{ kind: "json_equals", value }]), options);
      expect(report.cases[0]?.status).toBe("passed");
    }
  });

  it("does not treat missing output as an emitted empty string", async () => {
    const engine = runtime(new MockProvider({ chunks: [] }));
    expect(
      (await runEvaluation(engine, suite([{ kind: "text_equals", value: "" }]), options)).cases[0]
        ?.status,
    ).toBe("assertion_failed");
    const emitted = runtime(new MockProvider({ chunks: [""] }));
    expect(
      (await runEvaluation(emitted, suite([{ kind: "text_equals", value: "" }]), options)).cases[0]
        ?.status,
    ).toBe("passed");
  });

  it("checks fragmented tools independently without executing the tool", async () => {
    const engine = runtime(
      await provider([
        { type: "tool.call.started", call_id: "first", name: "lookup" },
        { type: "tool.call.arguments.delta", call_id: "first", delta: "broken" },
        { type: "tool.call.started", call_id: "second", name: "lookup" },
        { type: "tool.call.arguments.delta", call_id: "second", delta: '{"value":' },
        { type: "tool.call.arguments.delta", call_id: "second", delta: "0}" },
        { type: "execution.completed" },
      ]),
    );
    expect(
      (
        await runEvaluation(
          engine,
          suite([{ kind: "tool_call", name: "lookup", arguments: { value: 0 } }]),
          options,
        )
      ).cases[0]?.status,
    ).toBe("passed");
  });

  it("checks media result data and counts distinct artifact references without fetching them", async () => {
    const engine = runtime(
      await provider([
        {
          type: "output.result",
          result: { synthetic: true },
          artifacts: [
            { uri: "https://media.example.test/a.png" },
            { uri: "https://media.example.test/a.png" },
          ],
        },
        { type: "execution.completed" },
      ]),
    );
    const report = await runEvaluation(
      engine,
      suite([
        { kind: "result_equals", value: { synthetic: true } },
        { kind: "artifact_count", minimum: 2 },
      ]),
      options,
    );
    expect(report.cases[0]?.checks.map((check) => check.passed)).toEqual([true, false]);
    expect(JSON.stringify(report)).not.toContain("media.example.test");
  });

  it("records assertion failures separately from provider failures and hides raw errors", async () => {
    const failure = await provider([]);
    failure.execute = async function* () {
      throw new Error("synthetic-private-provider-error");
    };
    const report = await runEvaluation(runtime(failure), suite(), options);
    expect(report.cases[0]?.status).toBe("execution_failed");
    expect(report.complete).toBe(true);
    expect(JSON.stringify(report)).not.toContain("synthetic-private-provider-error");
    expect(
      (await runEvaluation(runtime(new MockProvider({ chunks: ["wrong"] })), suite(), options))
        .cases[0]?.status,
    ).toBe("assertion_failed");
  });

  it("records unsupported requirements without calling an upstream provider", async () => {
    const mock = new MockProvider();
    const execute = vi.spyOn(mock, "execute");
    const value = suite();
    value.cases[0]!.request.requirements = { tools: true };
    const report = await runEvaluation(runtime(mock), value, options);
    expect(report.cases[0]?.status).toBe("unsupported");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects nonisolated provider/model inventories before any execution", async () => {
    const first = new MockProvider({ id: "provider-a" });
    const execute = vi.spyOn(first, "execute");
    const engine = runtime(first);
    engine.register(new MockProvider({ id: "provider-b" }));
    await expect(runEvaluation(engine, suite(), options)).rejects.toThrow("isolated");
    expect(execute).not.toHaveBeenCalled();
    const single = new MockProvider();
    const manifest = await single.manifest();
    manifest.models.push({ ...manifest.models[0]!, model: "model-beta" });
    single.manifest = async () => manifest;
    await expect(runEvaluation(runtime(single), suite(), options)).rejects.toThrow("isolated");
  });

  it("stops if a provider changes its model after the attribution snapshot", async () => {
    const mock = new MockProvider();
    const manifest = await mock.manifest();
    let reads = 0;
    mock.manifest = async () => {
      const copy = structuredClone(manifest);
      if (++reads > 1) copy.models[0]!.model = "model-changed";
      return copy;
    };
    const execute = vi.spyOn(mock, "execute");
    const report = await runEvaluation(runtime(mock), suite(), options);
    expect(report.complete).toBe(false);
    expect(report.cases[0]?.status).toBe("evaluator_failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels quota-exceeding producers and stops subsequent cases", async () => {
    const mock = new MockProvider();
    let closed = false;
    mock.execute = async function* () {
      try {
        yield { type: "output.delta", output_index: 0, delta: "x".repeat(1024 * 1024 + 1) };
        yield { type: "execution.completed" };
      } finally {
        closed = true;
      }
    };
    const value = suite();
    value.repetitions = 2;
    const report = await runEvaluation(runtime(mock), value, options);
    expect(report.cases.map((row) => row.status)).toEqual(["evaluator_failed", "not_run"]);
    expect(closed).toBe(true);
  });

  it("honors the execution deadline without relabeling failure as a successful sample", async () => {
    const value = suite();
    value.case_timeout_ms = 5;
    const report = await runEvaluation(runtime(new MockProvider({ delayMs: 100 })), value, options);
    expect(report.cases[0]?.status).toBe("execution_failed");
    expect(report.metrics[0]?.p50_latency_ms).toBeNull();
  });

  it("cancels an active producer on caller interruption and marks remaining rows not run", async () => {
    const stop = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const mock = new MockProvider();
    let closed = false;
    mock.execute = async function* (context: ProviderExecutionContext) {
      try {
        started();
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("synthetic interruption")),
            { once: true },
          ),
        );
        yield { type: "execution.completed" };
      } finally {
        closed = true;
      }
    };
    const value = suite();
    value.repetitions = 2;
    const pending = runEvaluation(runtime(mock), value, { ...options, signal: stop.signal });
    await ready;
    stop.abort();
    const report = await pending;
    expect(report.complete).toBe(false);
    expect(closed).toBe(true);
    expect(report.cases.map((row) => row.status)).toEqual(["evaluator_failed", "not_run"]);
  });

  it("rejects unsafe/unbounded suites and report tampering", async () => {
    for (const value of [
      { ...suite(), cases: [] },
      { ...suite(), repetitions: 101 },
      { ...suite(), run_timeout_ms: 600001 },
      { ...suite(), unsupported: "synthetic" },
    ])
      expect(() => parseEvaluationSuite(value)).toThrow();
    const routing = suite();
    routing.cases[0]!.request.routing = { allow_fallback: true };
    expect(() => parseEvaluationSuite(routing)).toThrow();
    const regex = suite([{ kind: "text_contains", value: "x" }]);
    (regex.cases[0]!.checks[0] as unknown as Record<string, unknown>).pattern = "not-supported";
    expect(() => parseEvaluationSuite(regex)).toThrow();
    const value = suite();
    const report = await runEvaluation(runtime(), value, options);
    expect(() => parseEvaluationReport({ ...report, raw_output: "synthetic" }, value)).toThrow();
    const tampered = edited(report, (data) => {
      data.metrics[0]!.pass_rate = 0;
    });
    expect(() => parseEvaluationReport(tampered, value)).toThrow();
    const flags = edited(report, (data) => {
      data.cases[0]!.checks[0]!.passed = false;
    });
    expect(() => parseEvaluationReport(flags, value)).toThrow();
  });
});

describe("scenario-specific evidence recommendations", () => {
  it("selects different models for different scenarios from the same suite", async () => {
    const value = suite();
    value.repetitions = 5;
    value.cases = ["red", "blue"].map((scenario) => ({
      id: `case-${scenario}`,
      scenario,
      request: { ability: "text-generation", input: [{ type: "text", text: scenario }] },
      checks: [{ kind: "text_equals", value: `correct-${scenario}` }],
    }));
    const reports: EvaluationReport[] = [];
    const manifests: ProviderManifest[] = [];
    for (const [id, preferred] of [
      ["provider-a", "red"],
      ["provider-b", "blue"],
    ]) {
      const mock = new MockProvider({ id });
      mock.execute = async function* (context) {
        const input = context.request.input[0];
        const correct = input?.type === "text" && input.text === preferred;
        yield {
          type: "output.delta",
          output_index: 0,
          delta: correct ? `correct-${preferred}` : "wrong",
        };
        yield { type: "execution.completed" };
      };
      const engine = runtime(mock);
      reports.push(await runEvaluation(engine, value, options));
      manifests.push(...(await engine.manifests()));
    }
    const result = recommendModels(value, reports, {
      catalog: currentCatalog(manifests),
      contextId: options.contextId,
      evidenceKind: "fixture",
    });
    expect(
      result.scenarios.find((item) => item.scenario === "red")?.recommended_models[0]?.provider,
    ).toBe("provider-a");
    expect(
      result.scenarios.find((item) => item.scenario === "blue")?.recommended_models[0]?.provider,
    ).toBe("provider-b");
  });
  async function fixture() {
    const first = runtime(new MockProvider({ id: "provider-a", model: "model-alpha" }));
    const second = runtime(new MockProvider({ id: "provider-b", model: "model-beta" }));
    const value = suite();
    value.repetitions = 5;
    const reports = [
      await runEvaluation(first, value, options),
      await runEvaluation(second, value, options),
    ];
    const catalog = currentCatalog([...(await first.manifests()), ...(await second.manifests())]);
    return {
      value,
      reports,
      catalog,
      opts: { catalog, contextId: options.contextId, evidenceKind: "fixture" as const },
    };
  }
  it("keeps metric ties explicit instead of mixing quality and latency units", async () => {
    const { value, reports, opts } = await fixture();
    const result = recommendModels(value, reports, opts);
    expect(result.scenarios[0]?.recommended_models).toHaveLength(2);
    expect(result.metric).toBe("pass_rate");
    expect(result.scenarios[0]?.ranking[0]?.sample_count).toBe(5);
  });
  it("rejects mixed execution environments before ranking comparable evidence", async () => {
    const { value, reports, opts } = await fixture();
    const changed = edited(reports[1]!, (data) => {
      data.environment.node_major += 1;
    });
    expect(() => recommendModels(value, [reports[0]!, changed], opts)).toThrow(
      "environments must match",
    );
  });
  it("requires the current configuration fingerprint and rejects profile corruption", async () => {
    const { value, reports, opts } = await fixture();
    const configurations = structuredClone(opts.catalog.configurations);
    configurations[0]!.configuration_digest = evaluationDigest({ changed: true });
    const changed = createEvaluationCatalog(opts.catalog.catalog, configurations);
    expect(
      recommendModels(value, reports, { ...opts, catalog: changed }).scenarios[0]?.excluded[0]
        ?.reason,
    ).toBe("configuration_changed");
    expect(() => parseEvaluationCatalog({ ...changed, private_endpoint: "synthetic" })).toThrow();
    expect(() => parseEvaluationCatalog({ ...changed, digest: "invalid" })).toThrow();
    expect(() => createEvaluationCatalog(opts.catalog.catalog, [])).toThrow();
  });
  it("never recommends a model with zero completed samples even under a relaxed quality gate", async () => {
    const value = suite();
    value.repetitions = 5;
    const engine = runtime(new MockProvider({ failRetryably: true }));
    const report = await runEvaluation(engine, value, options);
    const result = recommendModels(value, [report], {
      catalog: currentCatalog(await engine.manifests()),
      contextId: options.contextId,
      evidenceKind: "fixture",
      minimumPassRate: 0,
    });
    expect(result.scenarios[0]?.excluded[0]?.reason).toBe("no_completed_samples");
    expect(result.scenarios[0]?.ranking).toEqual([]);
  });
  it("can rank only latency after a separate quality gate", async () => {
    const { value, reports, opts } = await fixture();
    const change = (report: EvaluationReport, latency: number) =>
      edited(report, (data) => {
        for (const row of data.cases) row.latency_ms = latency;
        data.metrics[0]!.p50_latency_ms = latency;
      });
    const result = recommendModels(value, [change(reports[0]!, 20), change(reports[1]!, 10)], {
      ...opts,
      metric: "p50_latency_ms",
    });
    expect(result.scenarios[0]?.recommended_models).toEqual([
      { provider: "provider-b", model: "model-beta" },
    ]);
    expect(result.metric).toBe("p50_latency_ms");
  });
  it("does not use fixture evidence for live recommendations", async () => {
    const { value, reports, opts } = await fixture();
    const result = recommendModels(value, reports, { ...opts, evidenceKind: "live" });
    expect(result.scenarios[0]?.status).toBe("insufficient_evidence");
    expect(result.scenarios[0]?.excluded[0]?.reason).toBe("evidence_kind_mismatch");
  });
  it("excludes stale, future and wrong-context evidence and rejects stale catalogs", async () => {
    const { value, reports, opts } = await fixture();
    const stale = edited(reports[0]!, (data) => {
      data.observed_at = new Date(Date.now() - 2 * 86400000).toISOString();
    });
    const future = edited(reports[1]!, (data) => {
      data.observed_at = new Date(Date.now() + 86400000).toISOString();
    });
    expect(recommendModels(value, [stale, future], opts).scenarios[0]?.ranking).toEqual([]);
    expect(
      recommendModels(value, reports, { ...opts, contextId: "different-context" }).scenarios[0]
        ?.excluded[0]?.reason,
    ).toBe("context_mismatch");
    expect(() =>
      recommendModels(value, reports, {
        ...opts,
        catalog: currentCatalog(
          opts.catalog.catalog.providers,
          new Date(Date.now() - 2 * 86400000).toISOString(),
        ),
      }),
    ).toThrow("fresh");
  });
  it("excludes missing models, changed capability declarations and insufficient sample sizes", async () => {
    const { value, reports, opts } = await fixture();
    expect(
      recommendModels(value, reports, { ...opts, catalog: currentCatalog([]) }).scenarios[0]
        ?.excluded[0]?.reason,
    ).toBe("model_not_in_current_catalog");
    const providers = structuredClone(opts.catalog.catalog.providers);
    providers[0]!.models[0]!.tools = true;
    expect(
      recommendModels(value, reports, { ...opts, catalog: currentCatalog(providers) }).scenarios[0]
        ?.excluded[0]?.reason,
    ).toBe("capability_changed");
    expect(
      recommendModels(value, reports, { ...opts, minimumSamples: 6 }).scenarios[0]?.ranking,
    ).toEqual([]);
  });
  it("refuses mixed suites and duplicate candidate reports instead of cherry-picking", async () => {
    const { value, reports, opts } = await fixture();
    const other = suite();
    other.id = "other-suite";
    expect(() => recommendModels(other, reports, opts)).toThrow("Invalid evaluation data");
    expect(() => recommendModels(value, [reports[0]!, reports[0]!], opts)).toThrow(
      "one evaluation report",
    );
  });
});
