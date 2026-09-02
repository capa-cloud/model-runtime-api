# Shared data-plane threat model

Status: v0.1 baseline. Review after every authentication, storage, provider, or deployment change.

## Assets

- Provider credentials supplied by the deployment environment
- Model inputs, outputs, tool arguments, result objects, and artifact URLs
- Routing policy and provider capability metadata
- Usage facts and execution metadata
- Event-store availability and integrity

## Trust boundaries

```text
Untrusted caller -> AI gateway -> Model Runtime -> Provider API
                                  |          |
                                  |          +-> external artifact URL
                                  +-> event store / telemetry exporter
```

The reference server has no caller authentication. It must remain on loopback or behind an
authenticated gateway. A deployment must not infer tenant identity from caller-controlled metadata.

## Primary threats and controls

| Threat | Required control |
| --- | --- |
| Credential disclosure | Environment or secret-manager injection; never include credentials in events, errors, logs, or manifests |
| Cross-tenant access | Gateway authorization bound to execution IDs; tenant identity stored server-side, not accepted as proof from metadata |
| Prompt/output disclosure | Metadata-only telemetry by default; content capture requires explicit redaction and retention policy |
| SSRF through media URIs | Adapter allowlists, scheme validation, download limits, and egress controls before dereferencing caller URIs |
| Retry amplification | Bounded attempts, retry budget, idempotency keys, and provider-aware cancellation |
| Queue exhaustion | Provider-local concurrency and queue depth; gateway-level tenant quotas |
| Malicious provider payload | Size limits, schema validation, safe JSON parsing, and no execution of returned content |
| Event tampering or replay | Monotonic sequence, append-only store, authenticated durable store, and cursor validation |
| Artifact expiry or substitution | Preserve media type and expiry; copy only through a deployment-owned validated storage path |
| Sensitive error leakage | Portable error codes and sanitized messages; raw provider bodies stay out of public events |

## Deployment requirements

- TLS and authenticated gateway on every non-loopback listener
- Provider credentials scoped per deployment and rotated outside repository files
- Durable store encryption, access control, retention, and backup policy
- Network egress allowlists for enabled providers
- Request and response size limits at both gateway and adapter layers
- Audit events without prompt/output content by default
- Explicit tenant binding for status, result, cancellation, and event-stream endpoints

## Out of scope

The repository does not claim to provide a hardened multi-tenant service, sandbox untrusted tools,
operate customer billing, or make provider artifact URLs permanent.
