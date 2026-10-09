# Storage and recovery verification

As of 2026-10-09. Reviewed base: `79142287d5b3635162cabe30dbf24ee16cee7b54`.
This verifies the bounded memory/local encrypted-file profile, not distributed production storage.

## Implemented behavior

- Capacity/retention bounds on memory records, event count, logical bytes, disk bytes and execution
  admission. Terminal records and identity mappings expire together; active subscriptions pin history.
- Synchronized AES-256-GCM journals with private permissions and a single-writer lease. Requests,
  raw identity keys and encryption keys are not journaled.
- Durable status/result/SSE replay and same-key identity replay across clean restart. Interrupted
  records become one non-retryable failure; recovery never calls a provider again.
- Fail-closed wrong-key/corruption/ownership/symlink handling, bounded crash-tail repair and
  unavailable-store readiness. Backend failures return sanitized server errors.
- Fixed a concurrent-completion replay race: events committed between list/status reads are read
  before the watcher terminates. Test worker concurrency is bounded to avoid process oversubscription.

## Fresh gates

| Gate | Evidence |
| --- | --- |
| Complete `pnpm check`, Node.js 24 | Passed: format, types, build, 97 TypeScript tests, SDKs, certification, schema, docs and public scans |
| Node.js 22 Linux | Same 97 tests passed in the isolated container with current source/compiled modules |
| Provider fixture verification | Four offline tests passed; no real accounts or public provider requests |
| Go/Python SDK | Fresh uncached Go tests and five Python tests passed |
| Dependency audit | No known vulnerabilities |
| Disclosure checks | Public-data scan and Secretlint passed; bounded internal-marker recheck found no matches |
| Real process lifecycle | Clean restart and SIGKILL recovery tested; dead fixture lease timestamp advanced to model expiry |
| Crash replay | Same retained execution, failed/non-retryable status, and unchanged upstream call count |
| Corruption/key tests | Refused startup without changing authenticated complete records or echoing content |
| Capacity tests | Logical/disk exhaustion retained a terminal failure; active records were not evicted |

## Container evidence

Final test image:
`sha256:058d6c9c087384ad52bf8390fd5cd6f51bfd6e4cb0e050065c1fffef49bcdd7a`.
It built from the frozen lockfile and ran as the `runtime` user with a read-only root filesystem,
all capabilities dropped and a private named data volume. After replacing the container, the
same idempotency key returned the same succeeded execution, result and cursor-based replay.
The task-owned containers and data volumes were removed after testing; no container was published.

## Remaining boundaries

Only local single-writer Linux/macOS filesystems are covered. Network filesystems, distributed
coordination, automatic provider-job reattachment, key rotation and backup deletion are not claimed.
Expiration is lazy; new use of an expired identity is explicitly a new execution. Existing data
requires compatible limits and the original encryption key.

The [delivery checklist](../delivery.md) still tracks capability truth/configuration, model radar
and evaluation, public-history release audit, active CI, real-account verification and release
packaging/cold-start gates. Those remain required before final delivery.
