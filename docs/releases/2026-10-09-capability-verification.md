# Model capability verification

As of 2026-10-09. Reviewed base: `c122104`.
This checkpoint verifies adapter declarations and translation with synthetic fixtures, not
real-account model capability certification.

## Fixed behavior

- OpenAI Responses and Anthropic Messages no longer advertise every optional vendor feature for
  arbitrary configured models. Default input is text/JSON-as-text, output is text, and tools are off.
- Image/file inputs and tools require explicit, validated deployment declarations. Unsupported
  modalities, duplicate/empty lists, null values and unknown fields are rejected.
- Structured output remains false: these adapters do not enforce a schema or produce a typed JSON
  output part. Requiring either capability fails before credentials or provider HTTP are used.
- Disabled tool declarations cannot bypass policy through provider request extensions or direct
  text-adapter SPI calls. Configured arrays and returned manifests cannot mutate routing policy.
- fal input/output modalities are configurable. Its default JSON input is now serialized into
  prompt text, preserving object, null, boolean and numeric values instead of silently dropping them.

## Fresh scoped verification

| Gate | Result |
| --- | --- |
| Provider/server dependency build and types | `pnpm exec tsc -b packages/server packages/provider-fal --pretty false` passed |
| Adapter/configuration/routing/cleanup tests | Six files, 58 tests passed on Node.js 24 |
| Exact test files | `provider-capabilities`, `config`, `provider-adapters`, `runtime`, `provider-network`, `fal-cancellation` |
| Formatting | Ten changed TypeScript/configuration files passed Biome |
| Documentation | Links, OpenAPI surface and four existing media assets passed |
| Disclosure checks | Public-data scan and Secretlint passed on the final publish candidate |
| Patch whitespace | `git diff --check` passed |

The new capability file contains 14 tests, including successful image translation for both text
adapters, no-call rejection for unsatisfied requirements, immutable declarations, tool-extension
rejection and exact fal request-body assertions outside the provider error path.

## Compatibility and limits

Existing image/tool users must add explicit verified declarations. fal output requirements also
need exact model output declarations. See the [adapter migration guide](../guides/provider-adapters.md).
Deployment declarations are operator assertions, not fresh vendor discovery or live certification.

The prior [storage checkpoint](2026-10-09-storage-verification.md) records the complete Node.js 22/24,
SDK and container baseline. This narrow patch reran its affected tests, types, docs and disclosure
gates; it does not claim a new full matrix, container release or live provider verification.
The [delivery checklist](../delivery.md) remains open for radar/evaluation, active CI, real-account
certification, public-history release audit, dependency review and final release/cold-start gates.
