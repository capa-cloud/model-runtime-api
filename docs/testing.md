# Testing and verification

## Complete gate

```bash
pnpm install --frozen-lockfile
pnpm check
```

The gate runs:

- Biome format verification;
- TypeScript project-reference type checking and build;
- Vitest unit, lifecycle, HTTP/SSE, Adapter fixture, OTel, and catalog tests;
- Go SDK tests;
- Python SDK standard-library tests;
- generated Schema drift check;
- custom public-data scan and Secretlint.

## Provider contract tests

Adapter tests use loopback HTTP fixture servers with fictional model, execution, and artifact IDs.
They verify request paths, SSE or polling lifecycle, tool argument deltas, usage mapping, result
artifacts, and terminal events. They do not use real provider credentials or call public provider
services.

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
