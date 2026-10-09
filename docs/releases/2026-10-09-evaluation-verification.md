# Scenario evaluation verification

As of 2026-10-09. Reviewed base: `2543a41f178aa3a8ae6d7a2fe31683b8d6384b26`.
This checkpoint verifies a runnable functional evaluation/recommendation workflow, not official
benchmark scores, real-account certification or production model quality.

## Delivered behavior

- An independent evaluation package/CLI with strict bounded suites, isolated provider/model
  attribution, fresh repetitions, no fallback and deterministic text/JSON/tool/result/artifact checks.
- Private summary reports bind suite, context, manifest, configuration and execution environment.
  No prompts, expected values, raw output/tools, artifact URLs, native errors, credentials or usage
  are exported. Portable execution error codes remain available for diagnosis.
- Execution/run/event bounds, caller cancellation, stop-on-evaluator-failure, skipped-row evidence
  and a CLI shutdown watchdog. Native cleanup is bounded; remote cancellation remains best effort.
- Current profile catalogs bind exact validated configurations without resolving credentials or
  executing inference. Configuration/capability/environment changes cannot reuse old results silently.
- Per-scenario advisory recommendations rank one metric with separate eligibility gates, explicit
  ties and exclusion reasons. Fixture evidence cannot satisfy a live recommendation request.
- A deterministic offline example, CLI shortcuts and normative tool documentation. The server
  exposes a configuration-value factory so each private file is read once before profile binding.
  Existing Runtime HTTP/request/provider contracts are unchanged.

## Fresh verification

| Gate | Result |
| --- | --- |
| Complete `pnpm check`, Node.js 24 | Passed: format, typecheck/build, 166 tests in 21 files, SDKs, fixture certification, schema, docs and disclosure scans |
| Node.js 22 Linux | 37 focused evaluation/config/CLI tests passed with current source/compiled packages mounted read-only into an isolated network-disabled container |
| Evaluation unit/policy coverage | 25 tests covering assertions, target binding, quotas, deadlines/interruption, report validation, freshness, configuration/env changes and scenario-specific selection |
| CLI integration | Six tests covering documented fixture JSON, profile collection, fixture/live separation, assertion exits, invalid configs and active-stream SIGTERM |
| Go/Python SDKs | Fresh Go tests and five Python tests passed |
| Provider protocol smoke | Four offline certification tests passed |
| Dependencies | No known vulnerabilities; the new package adds only workspace dependencies |
| Disclosure gate | Public-data and Secretlint scans passed; report tests assert synthetic sensitive input/output/errors do not escape |

The active CLI stream test uses only a loopback OpenAI-protocol fixture and an explicitly synthetic
credential. Its `live` execution-mode label is not a real-account certification claim. No real
provider account, public inventory API or public inference endpoint was called by these tests.

## Concrete acceptance cases

- Different synthetic scenarios select different provider instances from one comparable suite.
- Equal pass rates recommend every metric tie; latency selection does not add a hidden quality score.
- Empty emitted text differs from missing output. JSON falsy values and reordered keys are preserved.
- One malformed tool argument stream does not hide a later valid matching call; tools are not executed.
- Duplicate artifact references do not inflate counts; artifact URLs are not fetched or exported.
- Unsupported requirements never call the provider. A model changed after attribution stops before
  downstream execution. Output quotas/job interruption cancel this job and stop later repetitions.
- Corrupt or internally inconsistent summaries, mixed suites, duplicate candidate reports and incompatible execution
  environments are rejected. Stale/future evidence, changed profiles and missing samples are excluded.
- A model with zero completed samples is never recommended, including under relaxed quality gates.

## Remaining gates

These checks are functional assertions against synthetic fixtures, not statistical evidence of
market-model performance. Source trust, context/hardware control, account authorization, versioned
model selection and any external benchmark/judge remain operator responsibilities. Digests provide
integrity/change detection, not authentication or anonymization. No automatic routing was changed.

The [delivery checklist](../delivery.md) still requires release-candidate public-history audit,
active GitHub CI, dependency PR disposition, dedicated real-account certification and final
release/container/cold-start verification. This checkpoint publishes code and documentation only.
See the [evaluation guide](../guides/scenario-evaluation.md) for commands and limits.
