# Evaluation Tool Contract

Status: pre-alpha. The evaluation package is a client-side development tool; it adds no Runtime
HTTP fields, provider contract fields, billing features or automatic production routing.

## Suite and execution

`evaluation/1` suites are bounded JSON with opaque case/scenario identifiers, requests, assertions,
repetitions, per-case execution deadline and total-job budget. The evaluator must validate the
whole suite before calling a provider. Routing and request deadlines are evaluator-owned.

A run requires one provider/model declaration and binds provider, configured model ID, canonical
manifest digest, configuration digest, suite digest, context, execution mode and Node/platform/arch.
The configuration digest excludes resolved secret values: it hashes the validated deployment
configuration, including variable names and settings. It does not attest account identity.

Each repetition is a fresh one-attempt execution. Fallback is off; target changes, quota exhaustion
or evaluator interruption stop additional calls. Literal matching, parsed JSON equality, named
tool events, normalized results and distinct artifact references are valid deterministic checks.
No generated code/tool execution, artifact download, regex matching or remote schema retrieval occurs.

## Report

`evaluation-report/1` / evaluator version `1` reports include planned rows and scenario aggregates.
Each row is `passed`, `assertion_failed`, `execution_failed`, `unsupported`, `evaluator_failed` or
`not_run`. Native execution failures include only a portable `error_code`, not the error message.
Skipped rows have null latency. Incomplete/evaluator-failed runs are ineligible for recommendation.

Reports must not contain requests, expected values, raw output/results/tools, credentials,
artifact URLs, native error bodies, local paths, usage/cost data or upstream account ownership.
Digests and opaque metadata are still private evidence, not anonymization or cryptographic attestation.

Per-scenario pass/completion rates use all planned rows as denominator. Latency is a separate
millisecond measure over completed rows only; p50 uses nearest rank. An incomplete run cannot
be presented as a successful sample set even when some assertions passed.

## Current Profiles and Recommendation

`evaluation-catalog/1` contains a validated runtime capability snapshot and exactly one configuration
digest per provider/model identity. Profile collection does not execute inference. It must reject
ambiguous identities, incomplete bindings, unknown fields and mismatched digests.

Recommendation validates reports against the exact suite, recomputes aggregates, verifies profile
bindings and freshness, and rejects mixed execution environments for otherwise comparable reports.
One report per candidate is selected by the caller. No scores from different suites/official
benchmarks are silently mixed, and duplicate candidate reports cannot trigger cherry-picking.

Eligibility and ranking are distinct. Default eligibility requires five rows, pass rate 1,
complete evidence, matching context/mode/configuration/capabilities, and a 24-hour maximum age.
Unsupported scenarios and zero completed rows are ineligible. Ranking uses either pass rate
descending or p50 latency ascending; a tie recommends all tied candidates, not a hidden composite.

Outputs are advisory local evidence. Discovery is visibility metadata; declarations are operator
assertions; evaluation is observed functional behavior; official benchmarks and account certification
are separate evidence. None of these automatically changes a gateway's routing policy.
