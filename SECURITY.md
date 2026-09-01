# Security policy

## Supported versions

The project is pre-alpha. Security fixes are applied only to the latest `main` revision until the
first tagged release.

## Reporting a vulnerability

Use GitHub private vulnerability reporting when it is enabled for this repository. Do not open a
public issue containing credentials, exploit payloads, private endpoints, or sensitive execution
content.

## Reference server boundary

The reference server:

- binds to loopback by default;
- does not authenticate or authorize callers;
- stores execution state in memory;
- is intended for protocol development and conformance testing.

Deployments are responsible for TLS, authentication, tenant isolation, credential brokering,
durable storage, distributed flow control, audit retention, and sandboxing.

## Sensitive model content

Prompts, outputs, tool arguments, and artifacts may contain personal or confidential data. Runtime
implementations should default to metadata-only telemetry and make content capture an explicit,
redacted opt-in. This repository's tests use fictional content only.
