# Toolchain Migration Verification

As of 2026-10-09. Reviewed base: `76c6590cedd26372d2d456d10fe98e4bf9f6ad8b`.
Candidate implementation: `b4b3602e446e684c505747e0c28d1cca8308be76`.

## Adopted Versions

| Tool | Previous | Adopted | Evidence |
| --- | --- | --- | --- |
| TypeScript | 5.9.3 | 7.0.2 | Native compiler runs on macOS and Linux; all workspace references compile |
| Vitest | 4.1.11 | 5.0.3 | Current 5.x patch verified against registry metadata and both runtime lanes |
| Node type declarations | 24.13.3 | 26.6.4 | Strict build and actual Node.js 22/24 runtime tests pass |

Registry version/engine/integrity metadata was read before installation. No dependency install
script approval was added. The runtime support floor stays Node.js 22.12; newer declarations do
not claim new Node.js 26-only APIs are safe on older runtimes. Actual runtime tests remain required.

## Compatibility Fix

The first TypeScript 7 build rejected Node globals/modules in three Node-owned packages. Their
configs now explicitly load `types: ["node"]`: core, Mock Provider and fal Queue. Strictness was
not reduced. Browser-compatible transport and client packages were not given blanket Node globals.

Docker context now excludes `dist`, TypeScript build caches and Python bytecode, so a successful
Linux build cannot rely on host-generated JavaScript or compiler state. The optional `verification`
stage installs Git for scanner fixtures; the production runtime image retains its nonroot user and
production dependency boundary. Workspace bin-link warnings during the pre-build install do not
replace documented root-script verification; source-checkout commands build before running.

## Fresh Gates

| Gate | Result |
| --- | --- |
| Node.js 24 complete `pnpm check` | 173 product tests, 16 audit tests, four protocol-smoke fixtures, fresh Go/Python tests, type/build/schema/docs/public gates passed |
| Linux Node.js 22.22.0 | Clean native build; same 173 product tests, 16 audit tests, four smoke fixtures, schema and documentation passed |
| Linux checkout context | Clean candidate clone, no host `node_modules`/`dist`; public source copied into the verification container with scoped Git safe-directory configuration |
| Dependency vulnerability audit | No known vulnerabilities |
| Production container | Nonroot, read-only filesystem, network disabled, all capabilities dropped; readiness, provider inventory, execute, SSE terminal event, result, idempotent replay and clean shutdown passed |

Verification image: `sha256:c2e2c4d32d566304eaa5acaec047403ab3ebf555feae521f9529e4e074a691c5`.
Production test image: `sha256:d9cfa9c8ed26eaf372e15a2897973d6e8eef96fc66ea846b987bedeb184285bd`.
These are local verification images, not published release artifacts. Task containers were removed.

The first Node.js 22 tool run passed runtime/scanner/smoke/schema checks but documentation correctly
refused the bare image's missing Git checkout. The entire Node lane then passed using the clean
candidate clone; the failed check was not removed. The first new container probe used the wrong
result projection; it was corrected to the existing contract's text-output object and passed.

## Dependency PR Disposition

PR #2 (TypeScript 7.0.2), #6 (Vitest 5.0.0) and #8 (Node declarations 26.6.4) are superseded by
this integrated migration on the current main code. The Vitest candidate includes the newer
5.0.3 patch. Old PR lockfiles were not blindly merged over later dependency/security changes.
Their hosted closure is verified separately after the integrated commit is published.

## Boundaries

The [CI template](../ci/github-actions.example.yml) now includes production-container smoke and a
full checkout. It remains a template until workflow-write permission is available; no active CI or
required status check is claimed. No public inference call or real-account certification was
performed. Node.js 26 runtime coverage, old identity rewrite, a version tag and a published container
are not claimed. See the [delivery checklist](../delivery.md) for remaining gates.
