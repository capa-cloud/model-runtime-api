# Testing and verification

## Complete gate

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit:dependencies
```

The gate runs:

- Biome format verification;
- TypeScript project-reference type checking and build;
- Vitest unit, lifecycle, HTTP/SSE, Adapter fixture, OTel, and catalog tests;
- Go SDK tests;
- Python SDK standard-library tests;
- isolated OpenAI/Anthropic/fal protocol-smoke CLI fixtures;
- generated Schema drift check;
- custom public-data scan and Secretlint.

## Provider contract tests

Adapter tests use loopback HTTP fixture servers with fictional model, execution, and artifact IDs.
They verify request paths, SSE or polling lifecycle, tool argument deltas, usage mapping, result
artifacts, and terminal events. They do not use real provider credentials or call public provider
services.

Regression tests also cover partial-output fallback suppression, disabled fallback with multiple
requested attempts, fal polling exhaustion, bounded remote cancellation, early iterator closure,
completed-task retrieval failure, malformed lifecycle URLs, and ambiguous submission failures.

## Dependency and CI gate

`pnpm audit:dependencies` queries the current registry advisory database and fails for moderate or
higher severities, including development dependencies. It is separate from the offline-compatible
`pnpm check`. GitHub's empty alert list does not substitute for a fresh audit.

The CI template in [github-actions.example.yml](ci/github-actions.example.yml) tests Node.js 22
and 24, audits dependencies, and builds the container. It includes a weekly run to catch advisories
without requiring new commits. Until it is installed under `.github/workflows/`, these checks are
local evidence only; Dependabot update runs are not project CI. After activation, require both
matrix checks before merging. Major TypeScript and Node type upgrades need a separate compatibility
review and must not be merged solely because Dependabot opened them.

## Transport and process regressions

Tests exercise fragmented CRLF and UTF-8, comments, optional field spaces, batched small events,
per-event byte limits, response cancellation and nonterminal EOF. Provider-network tests use two
local fixture origins and confirm that redirects never reach the second origin. Server tests pause
an actual HTTP consumer and inject EventStore errors to verify backpressure and failure containment.

CLI lifecycle tests launch only task-owned child processes with synthetic credentials and local
fixture servers. They cover active-stream SIGTERM, bounded closure of incomplete HTTP requests,
and sanitized startup failures. Go checks disable test caching for fresh gate evidence; Go/Python
SDK regressions cover frame limits, cursors, truncation and required input values.

## Container check

```bash
docker build -t model-runtime-api:test .
docker run --rm -d --name model-runtime-test \
  -p 127.0.0.1:14320:4320 \
  -e MODEL_RUNTIME_HOST=0.0.0.0 model-runtime-api:test
curl --fail http://127.0.0.1:14320/v1/runtime
docker rm -f model-runtime-test
```

Use a task-specific container name and loopback port. The default image includes Mock only.

## Public-data checks

The repository scan rejects common credential formats, private keys, bearer tokens, private IPs,
local user paths, and internal-looking domains. Secretlint provides a second independent scan. GitHub
Secret Scanning and Push Protection remain repository-level controls.

No scanner proves that prose or fixtures are safe. Review every public diff for private architecture,
provider configuration, customer content, prices, routing weights, and local paths before push.

## Documentation media checks

`pnpm check:docs` validates Markdown and HTML image references, requires a provenance sidecar for
every bitmap, caps each image at 512 KiB, and caps all documentation bitmaps at 2 MiB. Generated
images also require manual inspection and an independent no-text image-read result. Exact technical
relationships remain deterministic and are separately rendered with Mermaid during release review.
