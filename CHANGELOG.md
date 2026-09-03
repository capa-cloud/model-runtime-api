# Changelog

All notable changes are documented here. The project follows semantic versioning after the first
tagged pre-alpha release.

## Unreleased

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
