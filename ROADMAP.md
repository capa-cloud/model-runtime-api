# Roadmap

The roadmap is capability-driven. Dates are intentionally omitted until maintainer capacity and
public adapter evidence are available.

## M0: Clean-room baseline

- [x] Protocol vocabulary and execution state machine
- [x] Provider SPI and capability manifests
- [x] Capability-based routing and bounded fallback
- [x] Provider-local concurrency and queue admission
- [x] Usage facts without customer billing
- [x] Deterministic mock provider and conformance runner
- [x] Loopback HTTP/SSE server and TypeScript SDK
- [x] Public-data scan and GitHub Actions workflow template
- [ ] Activate the GitHub Actions workflow after an authorized credential has workflow scope

## M1: Contract hardening

- [ ] Runtime schema validation generated from the normative specification
- [ ] Idempotent execution creation
- [ ] Explicit asynchronous submit/status/result lifecycle
- [ ] Durable event-store SPI and resumable SSE cursors
- [ ] Retry budgets and richer cancellation conformance
- [ ] OpenTelemetry GenAI semantic-convention mapping
- [ ] Threat model for shared data-plane deployments

## M2: Public provider adapters

- [ ] One typed synchronous/SSE model provider
- [ ] One content-block/tool-stream provider
- [ ] One asynchronous media-task provider
- [ ] Public-documentation evidence registry per adapter
- [ ] Sanitized contract fixtures and adapter-specific conformance suites

## M3: Ecosystem integration

- [ ] Go client SDK
- [ ] Python client SDK
- [ ] Optional sidecar packaging
- [ ] Gateway integration example with authentication remaining outside the runtime
- [ ] Versioned capability catalog and model-discovery experiment

## Non-goals

- Customer wallets, payments, invoices, discounts, taxes, or exchange rates
- A hosted model marketplace or public SaaS control plane
- Copying private provider configuration, production traffic, or proprietary routing policies
