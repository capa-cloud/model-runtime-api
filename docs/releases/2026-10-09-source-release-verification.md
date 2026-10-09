# Source Release Verification

As of 2026-10-09. Candidate implementation: `836a17108ee9b9d038772237045c9b4fb755d2b3`.
This is a verified source-artifact checkpoint, not a new published version or final delivery.

## Prepared Artifact

| Property | Evidence |
| --- | --- |
| Committed source files | 176 |
| Archive size | 1,042,879 bytes |
| Archive SHA-256 | `bc97a79938d23f1fabe8a53c30bae68d0bb82b4c570935141d633c744b5cadcd` |
| Toolchain | Node.js 24.14.1, zlib 1.3.1-e00f703, Apple Git 2.39.5 |
| Reproduction | Independent regeneration matched archive, manifest and checksum file byte-for-byte |

The archive contains only audited committed regular files. Git-generated tar contents were
extracted into a fresh private temporary directory and matched against every audited blob digest
before compression. The output has no Git history, account inventory, credentials, local deployment
configuration, dependency tree or compiled project outputs. The manifest records relative public
file paths and hashes. See [source release](../guides/source-release.md) for commands and limits.

## Fresh Verification

- Complete Node.js 24 `pnpm check`: 173 product tests, 25 audit/artifact tests, four protocol-smoke
  fixtures, Go/Python SDK checks, formatting, types/build/schema/docs and public scanning passed.
- Nine source-release tests also passed in the existing Linux Node.js 22 verification image with
  the current scripts mounted read-only and network disabled; host dependencies were not mounted.
- Regression cases reject changed archive/manifest/checksums, unexpected files, symbolic links,
  mutable refs, wrong project identity, generated outputs, committed secrets and private markers.
  Git archive omission/substitution attributes cannot evade the audited file inventory.
- Staged and worktree disclosure scans passed with the external private marker policy: 176 files,
  zero findings. The policy was neither committed nor packaged.
- Reachable history at this candidate: 26 commits, 362 distinct blobs, zero sensitive-content
  findings. Eleven legacy identity warnings remain across early commits; they are not silently
  waived, and no history rewrite was performed.
- Dependency audit: no known vulnerabilities.

## Archive Cold Start

The generated archive was extracted into a separate directory with no `.git`, `node_modules`,
compiled outputs or project build cache. Frozen-lockfile installation with install scripts disabled
passed. Dependencies could reuse the package store; project compilation was fresh.

From that extracted source, `pnpm test` built successfully and passed all 173 product tests.
Fresh Go tests and all five Python SDK tests passed. A separate CLI startup probe verified
loopback readiness, Mock-only provider inventory, HTTP submission, terminal SSE, normalized result,
idempotent replay and graceful shutdown. No live provider or network inference call was used.

The full Git-backed publication/document checks ran in the matching Git checkout, not the
metadata-free archive. Installation's pre-build workspace bin-link warnings do not prevent the
documented root scripts from building and running.

## Remaining Gates

The artifact remains local, unpublished and tied to the exact candidate above; a future source
change must produce and verify new bytes. Neither the existing `v0.1.0` tag nor release was changed.
Active GitHub CI/required checks, authorized real-account provider certification, explicit legacy
identity disposition and a new versioned release remain open in the [delivery checklist](../delivery.md).
Checksums are not signatures. Pattern scans do not replace human review of public text and images.
