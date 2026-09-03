# Contributing

## Before opening a change

1. Read `AGENTS.md` and the normative files under `spec/`.
2. Keep provider-specific behavior behind the Provider SPI or an explicit extension field.
3. Use fictional identifiers and sanitized fixtures only.
4. Add or update conformance tests for lifecycle and public-type changes.
5. Run `pnpm check`.

## Provider adapters

Adapters must cite the public vendor documentation used to implement the contract. Do not derive an
adapter from private source code, captured customer traffic, production logs, or undocumented
credentials. Document unsupported capabilities explicitly.

## Compatibility

The project is pre-alpha, but breaking changes still require:

- a decision record or compatibility note;
- matching protocol, implementation, tests, and examples;
- a clear migration description in the pull request.

## Documentation media

- Generated images are explanatory only; exact states, labels, values, and relationships belong in
  Mermaid, OpenAPI, tests, or normative text.
- Prompts must contain public information only and request no logos, provider branding, credentials,
  private endpoints, or customer content.
- Every bitmap under `docs/assets/` requires a neighboring `.prompt.md` provenance and QA record.
- Keep each bitmap below 512 KiB and the complete bitmap set below 2 MiB.
- Run `pnpm check:docs` and visually inspect the optimized consumer asset before committing.
