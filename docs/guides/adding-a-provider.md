# Adding a provider

Real provider adapters are intentionally absent from the initial baseline.

## Evidence requirements

Before implementation, record the public vendor documentation for:

- request and response schemas;
- stream event lifecycle;
- tool-call behavior;
- async submit, status, result, and cancellation behavior when applicable;
- usage fields and units;
- documented errors, retry guidance, and idempotency;
- data retention and credential requirements.

Do not use private source code, captured customer traffic, production logs, or undocumented
credentials as implementation input.

## Implementation checklist

1. Add a capability manifest with explicit unsupported fields.
2. Translate requests without changing core field meaning.
3. Normalize provider events but retain documented diagnostic codes.
4. Emit only sourced or clearly runtime-derived usage facts.
5. Add sanitized fixtures and run the conformance runner.
6. Add adapter-specific contract tests for stream termination, cancellation, errors, and usage.
7. Document credential injection without placing credentials in repository files.
