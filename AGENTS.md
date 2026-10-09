# Model Runtime API agent guide

This repository is a public, clean-room implementation. Treat every tracked file, test fixture,
commit message, issue, and generated artifact as publicly visible.

## Project boundary

- Define a provider-neutral contract for AI model execution.
- Keep protocol, runtime core, provider SPI, reference server, SDK, and conformance tests separate.
- The runtime may route and flow-control provider executions. It is not a tenant gateway, payment
  service, invoice system, secret manager, or model marketplace.
- Usage facts belong here. Customer billing, balances, discounts, taxes, and invoices do not.

## Data safety

- Never add credentials, cookies, tokens, private endpoints, customer payloads, production logs,
  internal provider names, private pricing, routing weights, or local absolute paths.
- Use fictional identifiers such as `provider-a`, `model-alpha`, and `code-generation`.
- Do not copy implementation code, configuration, schemas, comments, or tests from private systems.
- Provider adapters must be implemented only from public vendor documentation and sanitized fixtures.
- Run `pnpm scan:public` before every commit.

## Engineering rules

- Node.js 22.12+ and pnpm 10 are the supported toolchain.
- Keep the normative contract in `spec/`; code must not silently redefine it.
- Provider-specific behavior belongs behind the SPI or an explicit extension field.
- Unsupported capabilities must fail explicitly before execution.
- Every lifecycle or public type change requires conformance tests and compatibility notes.
- The reference server binds to loopback and is unauthenticated; never present it as an internet-ready
  multi-tenant gateway.

## Verification

Run:

```bash
pnpm check
```

This includes formatting, TypeScript/Go/Python tests, type checking, build, and public-data scanning.
