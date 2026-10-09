# Changelog

All notable changes are documented here. The project follows semantic versioning after the first
tagged pre-alpha release.

## Unreleased

### Fixes

- Fail publication scans closed on unreadable/oversized/unsupported inputs, inspect staged Git
  objects even when working files differ, and add reachable-history/current-hosted metadata audits.
- Keep private policies outside the repository, redact finding locations/content, reject debug
  environments and moving refs, and include detector regressions in the complete local gate.


- Replace provider-wide capability claims with conservative model-specific declarations. Text
  adapters require explicit image/file/tool support and no longer advertise typed JSON or
  schema-enforced structured output. fal modality declarations are configurable and validated.
- Reject disabled tool declarations in extensions before credential resolution or HTTP calls;
  isolate capability configuration from caller and manifest mutations.
- Preserve fal JSON input parts by serializing them into prompt text instead of silently dropping
  their values. Native model parameter objects remain explicit provider extensions.

- Add bounded memory retention and opt-in AES-256-GCM event journals with atomic idempotency claims,
  synchronized writes, single-writer ownership and conservative restart recovery.
- Bound active execution admission, copy request data before asynchronous routing, and preserve
  terminal failure evidence on event-capacity exhaustion. Provider completion stops stream consumption.
- Report storage failures as sanitized server errors and expose unavailable/stopping readiness.

- Share bounded standards-based SSE decoding across providers and TypeScript clients; handle
  comments, fragmented line endings/UTF-8, batched events and early response cancellation.
- Reject provider redirects and unsafe fal model/lifecycle URLs. Sanitize CLI startup failures.
- Respect SSE backpressure and contain asynchronous stream errors. Add orderly runtime shutdown
  and a bounded CLI grace period.
- Preserve required empty text and JSON null in Go requests; bound Go/Python cumulative SSE frames
  and report streams truncated before a terminal event.
- Infer input modality requirements before routing and avoid echoing caller-controlled ability
  content in capability errors.

- Prevent fallback after exposing text, tool calls, or results; partial failures are terminal and
  non-retryable. Honor disabled fallback even when multiple attempts are requested.
- Attempt bounded, deduplicated fal cancellation on unfinished-task exits. Suppress automatic
  retries after accepted or ambiguous submissions to avoid duplicate remote tasks.

### Maintenance

- Add an isolated scenario-evaluation library/CLI, deterministic text/JSON/tool/media assertions,
  bounded cancellation and private summary reports. Synthetic fixtures are not model benchmarks.
- Bind recommendations to fresh suite, context, execution environment, configuration and capability
  evidence. Rank one metric at a time with separate quality gates, explicit ties and exclusions.

- Add complete account-visible OpenAI/Anthropic inventory discovery, visibility radar, private
  atomic polling state and a repository CLI command. Vendor metadata does not imply model release,
  retirement, quality or inference capability. No schedules or notifications are installed.
- Validate and canonicalize runtime catalog metadata and digests; bound reads, reject redirects,
  and redact CLI failure output. Structurally valid legacy catalog digests remain comparable.

- Add an explicit live/fixture provider smoke tool and sanitized reports. Offline certification
  tests never read real provider credentials or call public endpoints.

- Upgrade Vitest, Biome, and YAML; constrain vulnerable fast-uri and source-map-js versions to
  patched releases. Contributor tooling now requires Node.js 22.12 or newer.
- Add an explicit dependency-audit command and a Node.js 22/24 CI template with weekly audits.
- Add lifecycle and remote-task cleanup regression coverage.

### Documentation

- Reorganized the English and Chinese README around audience paths, execution boundaries, provider
  behavior, usage, and safe deployment.
- Added four optimized AnyCap editorial images with public prompts, provenance, and independent
  no-text QA.
- Added exact Mermaid architecture and lifecycle diagrams alongside non-normative concept images.
- Extended documentation checks to validate HTML image references, provenance sidecars, per-image
  size, and total bitmap weight.

## 0.1.0 - 2026-09-02

- Provider-neutral execution protocol and capability manifests
- Idempotent asynchronous execution lifecycle with status, result, cancel, and resumable SSE events
- Provider-local flow control, bounded fallback, retry budget, and append-only EventStore SPI
- OpenAI Responses, Anthropic Messages, fal Queue, Mock, and conformance adapters
- Usage facts and metadata-only OpenTelemetry GenAI mapping without customer billing
- TypeScript, Go, and Python clients
- Capability catalog snapshots and model diff
- Container and Kubernetes sidecar examples
- Public-data scan, threat model, evidence registry, and contributor security guidance
