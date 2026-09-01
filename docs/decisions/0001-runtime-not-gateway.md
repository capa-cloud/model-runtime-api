# ADR-0001: Runtime data plane, not tenant gateway

- Status: accepted
- Date: 2026-09-01

## Context

AI gateways and provider SDKs often combine protocol translation, tenant authentication, budgets,
routing, provider concurrency, usage, and billing. Combining all of these concerns would make the
public contract difficult to embed, test, and adopt alongside an existing gateway.

## Decision

Model Runtime API is a provider-neutral execution data plane. It owns model capability negotiation,
execution routing, provider-local flow control, lifecycle events, cancellation, error normalization,
and usage facts.

Authentication, tenant authorization, commercial quotas, customer pricing, payment, and invoicing
remain gateway or control-plane responsibilities.

The project ships an optional loopback reference server and client SDK. The server is not presented
as an internet-ready multi-tenant gateway.

## Consequences

- Existing gateways can call or embed the runtime without replacing their tenant control plane.
- Provider flow control and route evidence remain centralized when the runtime is deployed as a
  shared service.
- Deployments must add their own production security and durable coordination.
- Billing integrations consume usage facts rather than modifying execution truth.
