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

- [x] Runtime schema validation generated from the normative specification
- [x] Idempotent execution creation
- [x] Explicit asynchronous submit/status/result lifecycle
- [x] Durable event-store SPI and resumable SSE cursors
- [x] Retry budgets and richer cancellation conformance
- [x] OpenTelemetry GenAI semantic-convention mapping
- [x] Threat model for shared data-plane deployments

## M2: Public provider adapters

- [x] One typed synchronous/SSE model provider
- [x] One content-block/tool-stream provider
- [x] One asynchronous media-task provider
- [x] Public-documentation evidence registry per adapter
- [x] Sanitized contract fixtures and adapter-specific conformance suites

## M3: Ecosystem integration

- [x] Go client SDK
- [x] Python client SDK
- [x] Optional sidecar packaging
- [x] Gateway integration example with authentication remaining outside the runtime
- [x] Versioned capability catalog and model-discovery experiment

## Post-0.1 candidates

These are not part of the completed v0.1 contract:

- production durable EventStore implementations and distributed flow-control coordination;
- live-account provider certification and scheduled model-radar ingestion;
- stable package-registry publication after API feedback;
- authenticated hosted gateway, tenant control plane, or customer billing.

## Non-goals

- Customer wallets, payments, invoices, discounts, taxes, or exchange rates
- A hosted model marketplace or public SaaS control plane
- Copying private provider configuration, production traffic, or proprietary routing policies
