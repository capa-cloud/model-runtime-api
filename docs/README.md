# Documentation index

## Start here

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | System boundaries, package map, and execution paths |
| [Runtime model](../spec/runtime-model.md) | Normative roles, states, routing, usage, and storage boundary |
| [Protocol](../spec/protocol.md) | Normative request, events, errors, usage, and extensions |
| [OpenAPI](../spec/openapi.yaml) | Machine-readable HTTP surface |
| [Roadmap](../ROADMAP.md) | Completed v0.1 scope and explicitly deferred work |

## Implement and integrate

| Document | Purpose |
| --- | --- |
| [Provider adapters](guides/provider-adapters.md) | Safe adapter configuration and provider-specific behavior |
| [Adding a provider](guides/adding-a-provider.md) | Public evidence and conformance checklist |
| [Gateway integration](guides/gateway-integration.md) | Authentication, tenant, quota, and usage boundary |
| [Model catalog](guides/model-catalog.md) | Versioned capability snapshots and model discovery diff |
| [Testing](testing.md) | Reproducible local, SDK, container, and security verification |
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
