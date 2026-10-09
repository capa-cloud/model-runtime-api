# Delivery checkpoint: transport and lifecycle hardening

As of 2026-10-09. Reviewed base: `9d310b1650fe51056578c66f7679669dae32104e`.
This is verified progress on `main`, not a claim that all final-delivery gates are complete.
The [delivery checklist](../delivery.md) owns the remaining work.

## Changes

- Added a shared browser-compatible transport package using `eventsource-parser` instead of two
  separate SSE parsers. It bounds pending characters, emitted UTF-8 bytes and JSON bodies, and
  cancels abandoned/oversized responses.
- Rejected provider redirects, unsafe fal lifecycle URLs and origin-changing model identifiers.
  CLI startup failures no longer print configuration source content.
- Added SSE backpressure, asynchronous failure containment and bounded CLI shutdown, including
  keep-alive responses that become idle after shutdown begins.
- Added runtime shutdown admission control and pending-submission cleanup. Routing now infers
  actual input modalities and avoids echoing caller-controlled values in public errors.
- Made execution-deadline failures non-retryable; downstream acceptance/output may be ambiguous.
- Preserved required zero values in Go input parts and bounded Go/Python SSE frames. Clients
  report streams truncated before a terminal event.
- Added explicitly scoped fixture/live provider smoke verification with reports that omit output,
  artifact URLs, credentials and usage/financial quantities.

## Fresh evidence

| Gate | Result |
| --- | --- |
| `pnpm check`, Node.js 24 | Passed after the final runtime changes |
| TypeScript/Vitest | 15 files, 74 tests passed |
| Node.js 22.22.0 Linux compatibility | Same 74 tests passed against the current packages/tests in a container |
| Provider smoke fixtures | Four tests passed on Node.js 22 and 24; no live credentials or public provider calls |
| Go SDK | Fresh, uncached `go test -count=1 ./...` passed |
| Python SDK | Five tests passed |
| Format/typecheck/build | Passed; 13 workspace projects |
| Generated request schema | No drift |
| Documentation/OpenAPI/media | Local links, HTTP paths and four optimized media assets passed |
| Public-data/Secretlint | Passed; no known internal markers found in the bounded recheck |
| Dependency audit | No known vulnerabilities in the current advisory database |

Node.js 22 compatibility used an isolated builder container with the current package sources,
compiled modules, tests and scripts mounted read-only. The full fixture suite and live-stream
SIGTERM/incomplete-request shutdown cases are tested; this does not certify real provider accounts.
Task-owned fixture processes, servers and containers are cleaned up after testing.

## Open gates

The GitHub credential still lacks workflow-write permission, so remote project CI and required
checks are not active. The template remains ready for activation; no green Dependabot job is
presented as project CI.

Real-account smoke verification requires dedicated, authorized public-project credentials and
explicit model selection. The smoke suite is not comprehensive feature or quality certification.
Retention/recovery, capability truth, discovery/evaluation workflows, dependency-major review,
release packaging and final cold-start verification remain tracked in the delivery checklist.
