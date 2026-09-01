# ADR-0002: Usage facts are not billing records

- Status: accepted
- Date: 2026-09-01

## Context

AI providers report heterogeneous units: tokens, cache operations, requests, media counts, media
seconds, and provider-native units. Prices vary by provider, model, service tier, region, contract,
and effective period.

## Decision

The runtime emits immutable usage facts containing unit, quantity, source, and completeness. The
core protocol does not attach customer prices or calculate invoices.

Price catalogs, currency conversion, discounts, adjustments, customer ledgers, and invoices are
separate consumers. Optional cost estimation must identify its price version and remain explicitly
non-final.

## Consequences

- Usage remains stable when prices change.
- Unknown units remain visible instead of becoming silent zero cost.
- Financial correctness can evolve independently from provider execution.
