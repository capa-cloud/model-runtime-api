# Scenario evaluation and recommendations

The evaluation package runs bounded, deterministic assertions against an isolated configured
model. It is a functional evaluation harness, not HLE, an official intelligence leaderboard, a
statistical guarantee, an LLM judge or a generated-code execution sandbox.

## Run the offline example

```bash
pnpm build
umask 077
mkdir -p .model-research
pnpm --silent evaluate run fixture deploy/evaluation-suite.example.json fixture-context > .model-research/fixture-run-001.json
pnpm --silent evaluate catalog fixture > .model-research/fixture-catalog.json
pnpm --silent evaluate recommend fixture deploy/evaluation-suite.example.json .model-research/fixture-catalog.json fixture-context pass_rate .model-research/fixture-run-001.json
```

The bundled suite is explicitly synthetic: it checks the Mock Provider's text contract over ten
rows, not the quality of a market model. `fixture` mode loads only that mock and has no provider
configuration argument. Build first; `--silent` keeps package-manager banners out of JSON.
Use unique report filenames; shell redirection can truncate an older report before a command runs.

## Build a private scenario suite

Each case has an opaque ID, scenario, normal execution request and one or more assertions.
Requests cannot specify routing/deadlines: evaluation owns one attempt, disables fallback and
uses the suite's execution deadline. Input and requirement validation still belongs to the Runtime.

| Assertion | Tests | Does not test |
| --- | --- | --- |
| `text_equals` | Exact text at one output index, including an emitted empty string | General answer quality |
| `text_contains` | Nonempty literal fragment, case sensitive | Semantic similarity |
| `json_equals` | Parsed text JSON equals expected JSON, independent of object key order | Provider-enforced structured output |
| `tool_call` | Named emitted call and optionally complete parsed arguments | Tool execution or external side effects |
| `result_equals` | Native normalized result data equals expected JSON | Downloaded media quality |
| `artifact_count` | Minimum distinct returned artifact references | URL reachability, retention or asset quality |

Use realistic, authorized, private test data and explicit correctness criteria for each scenario.
For open-ended answers, use a separate reviewed benchmark/judge workflow; do not interpret literal
matching as broad reasoning quality. Code is never executed, regexes are not supported, and no
artifact URI is fetched. `json_equals` also supports JSON null, scalars and arrays; it is post hoc
validation and does not enable the Runtime's `structured_output` capability.

Bounds: 1 MiB suite JSON, depth 64, 1-5 repetitions, at most 100 total rows, 32 assertions per
case, 60 seconds maximum execution deadline and 10 minutes maximum complete-job budget. Each
case has a 1 MiB cumulative event/4096-event cap. Native cleanup may take up to 10 seconds beyond
the case deadline, but not beyond the job budget. Evaluator interruption/quota/attribution failures
stop further submissions. Remaining planned rows become `not_run`, and the report is incomplete.

## Authorized live runs

Prepare a dedicated configuration file containing exactly one provider instance and model. Use
environment-variable **names**, never credential values. Persistent `event_store` configuration
is rejected. Use unique provider IDs across model configurations, such as `provider-a` and
`provider-b`, even when both are instances of the same vendor adapter.

```bash
pnpm --silent evaluate run live .model-research/suite.json .model-research/provider-a.json experiment-a > .model-research/provider-a-run-001.json
pnpm --silent evaluate run live .model-research/suite.json .model-research/provider-b.json experiment-a > .model-research/provider-b-run-001.json
pnpm --silent evaluate catalog live .model-research/provider-a.json .model-research/provider-b.json > .model-research/current-evaluation-catalog.json
pnpm --silent evaluate recommend live .model-research/suite.json .model-research/current-evaluation-catalog.json experiment-a pass_rate .model-research/provider-a-run-001.json .model-research/provider-b-run-001.json
```

`live` is an explicit outbound-execution mode, not independent proof of a real vendor account.
The caller must authorize those credentials and requests. Do not borrow private-system accounts.
Each repetition is a new execution; no idempotent replay or automatic retry can inflate sample
counts. The model target is checked against the attribution snapshot before downstream execution;
a changed target stops the job. Prefer versioned model IDs: a mutable alias does not pin weights.

The context ID must identify the same controlled experiment: input suite, account/region visibility,
hardware, network, sampling policy and operational conditions. Use an opaque alias rather than a
customer, organization, hostname or person. Node.js major version, platform and architecture are
recorded automatically; different execution environments cannot share a comparison cohort.
Those fields do not prove equal hardware/network conditions; the operator owns the context label.

## Read the report

Reports contain suite/configuration/manifest digests, context, execution mode, environment,
per-case assertion booleans, portable error codes and scenario aggregates. They omit prompts,
expected assertion values, raw results/text/tool arguments, artifact URLs, provider error bodies,
credentials, local paths, usage facts and financial data. Execution uses the direct streaming
Runtime API, so no execution output is appended to an EventStore.

Scenario aggregates keep separate measures:

- `pass_rate`: all assertions passed divided by planned rows for that scenario;
- `completion_rate`: successful terminal executions, including assertion failures, divided by rows;
- `p50_latency_ms`: nearest-rank median of completed rows' client-side execution latency, not
  provider compute time, TTFT or tokens per second.

Missing text is not equal to an emitted empty string. Provider failure, unsupported capability,
assertion failure, evaluator failure and skipped rows are distinct. `complete` means every planned
row received a valid evaluation outcome, not that every model assertion passed.

`run` exits 0 only when complete and all rows pass. Assertion failures still produce a valid
sanitized report with exit 1; malformed inputs produce no report. SIGINT/SIGTERM cancels only this
job's known execution, stops later submissions and emits an incomplete report when attribution is
available. A final process watchdog bounds shutdown. Local exit/cancellation is not proof that
remote compute stopped, especially for asynchronous media providers.

## Recommend without mixing units

Recommendation requires a fresh **evaluation catalog**, not a vendor discovery inventory or plain
runtime catalog. `catalog live` reads exact configurations and obtains their local declarations,
without inference calls or credential resolution. It binds each model to the same configuration
digest used during evaluation. Configuration/capability changes require rerunning evaluation.

Default gates are five rows per scenario, every row passing, complete reports, matching suite and
context, matching current configuration/capability, matching declared mode, compatible execution
environment and evidence/catalog no older than 24 hours. Future-dated evidence is refused. The
library can explicitly adjust sample/pass/age thresholds; zero completed rows or unsupported
scenario capabilities are never recommendations even when quality thresholds are relaxed.

Select **one** metric: `pass_rate` (higher is better) or `p50_latency_ms` (lower is better, after
the separate quality gate). There is no composite score. Metric ties return all tied models;
model identifiers only stabilize display ordering. Every excluded candidate has a reason.
Different suites, corrupt summaries or duplicate reports for one candidate are rejected instead
of silently combining or choosing a favorable run. The operator must choose the report cohort.

Fixture reports cannot satisfy a live request. Recommendations remain advisory: no routing policy
is modified, and functional evaluation does not replace smoke/access checks or production review.
Official benchmark scores belong to a separately sourced, versioned benchmark dataset, with their
own metric/conditions; this harness neither invents them nor mixes them into its pass/latency scale.

## Data safety

Treat generated suites, reports and evaluation catalogs as private. Model IDs, fine-tunes, aliases,
context labels and guessed small-input hashes can still reveal sensitive information. SHA-256
digests detect changes/corruption, not authentication or anonymization: an untrusted party can
forge a report and recompute its digest. Read only reviewed evidence from trusted private storage.
`.model-research` is excluded from Git and Docker context. Do not publish generated files, console
logs or account inventories by default. Vendors receive live input and apply their own retention
policies; local report projection does not govern upstream storage.

See the [normative evaluation contract](../../spec/evaluation.md) and
[provider certification workflow](provider-certification.md) for the separate protocol/access gate.
