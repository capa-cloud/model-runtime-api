# Model Runtime API

[简体中文](README.zh-CN.md)

Model Runtime API is a provider-neutral contract and reference runtime for routing, controlling,
observing, and metering AI model executions.

It sits between an application or AI gateway and model providers. Applications integrate with one
execution lifecycle while adapters translate public provider protocols such as synchronous JSON,
SSE streams, and asynchronous media jobs.

> Project status: pre-alpha clean-room baseline. No real provider adapter is included yet.

## What it is

```text
Application / Agent / AI Gateway
                |
        Model Runtime API
   protocol + routing + flow control
                |
          Provider SPI
                |
      Hosted or self-hosted models
```

The repository delivers:

- a versioned protocol and execution state machine;
- capability-based provider selection and explicit fallback evidence;
- provider-local concurrency control;
- normalized stream events and asynchronous task states;
- provider-reported or runtime-derived usage facts;
- a provider SPI, deterministic mock provider, and conformance runner;
- an optional loopback HTTP/SSE reference server and TypeScript client SDK.

## What it is not

- an internet-ready multi-tenant AI gateway;
- an authentication, API-key, quota, or tenant management service;
- a payment, wallet, invoice, or customer billing system;
- a portable model-behavior standard;
- a copy or distribution of any private MaaS implementation.

## Workspace packages

| Package | Responsibility |
| --- | --- |
| `@model-runtime/protocol` | Public types, events, state, capability and usage vocabulary |
| `@model-runtime/core` | Provider registry, routing, concurrency and in-memory execution runtime |
| `@model-runtime/provider-mock` | Deterministic provider for tests and local development |
| `@model-runtime/conformance` | Reusable provider contract checks |
| `@model-runtime/server` | Loopback HTTP/SSE reference server |
| `@model-runtime/sdk-typescript` | TypeScript HTTP/SSE client |

Workspace package names are not published to a registry in the pre-alpha phase.

## Quick start

Requirements: Node.js 22 or later and pnpm 10.

```bash
pnpm install
pnpm check
pnpm dev
```

The reference server listens on `127.0.0.1:4320`. It is intentionally unauthenticated and must not
be exposed to an untrusted network.

```bash
curl -s http://127.0.0.1:4320/v1/runtime

curl -N -X POST http://127.0.0.1:4320/v1/executions \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{
    "ability":"text-generation",
    "requirements":{"stream":true},
    "input":[{"type":"text","text":"hello"}]
  }'
```

## Design boundaries

- The caller selects an ability and required capabilities, not a provider credential.
- The runtime records the resolved provider/model and every fallback attempt.
- Provider-specific options remain in an explicit extension namespace.
- Usage is an immutable execution fact. Price resolution and billing are separate layers.
- A deployment may embed the core for tests, run it as a sidecar, or operate it as a shared data
  plane behind an AI gateway.

Read [Runtime model](spec/runtime-model.md), [Protocol](spec/protocol.md), and
[ADR-0001](docs/decisions/0001-runtime-not-gateway.md) before changing the public surface.
The staged implementation plan is tracked in [ROADMAP.md](ROADMAP.md).

## Security and public-data policy

All examples are fictional. Do not submit credentials, private endpoints, customer data, production
logs, private prices, or proprietary routing configuration. Run `pnpm scan:public` before commits.
See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0.
