# Documentation index

![Provider-neutral model execution passing through one stable runtime.](assets/model-runtime-hero.jpg)

*Concept image. Normative behavior lives in `spec/`.*

## Start here

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | System boundaries, package map, and execution paths |
| [Runtime model](../spec/runtime-model.md) | Normative roles, states, routing, usage, and storage boundary |
| [Protocol](../spec/protocol.md) | Normative request, events, errors, usage, and extensions |
| [OpenAPI](../spec/openapi.yaml) | Machine-readable HTTP surface |
| [Roadmap](../ROADMAP.md) | Completed v0.1 scope and explicitly deferred work |
| [Delivery checklist](delivery.md) | Current acceptance gates and remaining final-delivery work |
| [Transport delivery checkpoint](releases/2026-10-09-delivery-checkpoint.md) | Transport, lifecycle, SDK and security verification evidence |
| [Storage verification](releases/2026-10-09-storage-verification.md) | Current persistence, retention, replay, process-crash and container evidence |
| [Capability verification](releases/2026-10-09-capability-verification.md) | Conservative declarations, configuration, no-call rejection and JSON input mapping |

## Implement and integrate

| Document | Purpose |
| --- | --- |
| [Provider adapters](guides/provider-adapters.md) | Safe adapter configuration and provider-specific behavior |
| [Provider smoke verification](guides/provider-certification.md) | Opt-in live protocol checks, isolated fixtures and sanitized evidence |
| [Event storage and recovery](guides/event-storage.md) | Bounded memory, encrypted journals, durable identity, retention and restart semantics |
| [Adding a provider](guides/adding-a-provider.md) | Public evidence and conformance checklist |
| [Gateway integration](guides/gateway-integration.md) | Authentication, tenant, quota, and usage boundary |
| [Model catalog](guides/model-catalog.md) | Versioned capability snapshots and model discovery diff |
| [Testing](testing.md) | Reproducible local, SDK, container, and security verification |
| [2026-10-09 hardening verification](releases/2026-10-09-hardening-verification.md) | Lifecycle fixes, dependency audit, regression results, and CI delivery limits |
| [v0.1.0 verification](releases/0.1.0-verification.md) | Release gate results and explicit residual limits |
| [v0.1.0 release notes](releases/0.1.0-notes.md) | Shipped scope, verification summary, and platform limitation |

## Security and evidence

| Document | Purpose |
| --- | --- |
| [Threat model](security/threat-model.md) | Shared data-plane assets, threats, and deployment controls |
| [Provider evidence](evidence/provider-sources.md) | Dated public sources used by clean-room adapters |
| [Security policy](../SECURITY.md) | Vulnerability reporting and supported security boundary |
| [Public contribution policy](../CONTRIBUTING.md) | Data safety, compatibility, and verification requirements |

## Decisions

- [ADR-0001: Runtime data plane, not tenant gateway](decisions/0001-runtime-not-gateway.md)
- [ADR-0002: Usage facts are not billing records](decisions/0002-usage-is-not-billing.md)

## Visual assets

The four editorial images under `assets/` were generated through AnyCap and optimized to 1600 x 900
JPEG for GitHub delivery. Each image has a neighboring `.prompt.md` file containing its public
prompt, generation request ID, processing record, and independent image-read result. Exact protocol
facts remain in Mermaid, OpenAPI, tests, and normative text rather than generated pixels.
