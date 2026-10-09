# Runtime hardening verification

- As of: 2026-10-09
- Reviewed baseline: `9477bf29721637d09278d67ec40ca2e667804b7c`
- Scope: post-0.1 lifecycle fixes and dependency maintenance on `main`; not a new tagged release
- Evidence: public synthetic fixtures only; no live provider credentials or requests

## Behavior changes

Fallback is now restricted to failures before text, tool calls, tool arguments, or results have
been exposed. Partial-output failures terminate with `retryable: false`; consumers can inspect
partial evidence but cannot retrieve it as a successful HTTP result. `allow_fallback: false` always
limits routing to one attempt, regardless of `max_attempts`.

The fal adapter attempts one bounded cancellation request when leaving an unfinished remote task.
Polling exhaustion, polling errors, consumer cancellation, and early iterator closure share this
cleanup. Submitted or ambiguous remote tasks are non-retryable; cancellation does not prove a
running task stopped. Completed tasks are not cancelled, even if result retrieval fails or aborts.

## Verification

| Check | Result |
| --- | --- |
| `pnpm check` on Node.js 24 | Passed: formatting, typecheck, build, schema, documentation and public-data checks |
| Vitest | 10 files, 41 tests passed; 15 regression cases added |
| Go/Python SDK checks | Passed; Go reused valid cached results, Python ran two tests |
| Dependency audit | No known vulnerabilities in the current registry advisory database |
| Secretlint and public-data scan | Passed; bounded internal-marker recheck found no matches |
| Container build | Passed on Node.js 22.22.0 with frozen lockfile |
| Container execution | Healthy, non-root, read-only filesystem, all capabilities dropped |
| Container HTTP/SSE | Submit, idempotent replay, seven ordered events, cursor resume and result passed |
| CI template | Parsed successfully; Node.js 22/24 matrix, dependency audit and weekly schedule present |

Container image tested:
`sha256:4c54156ee7727c77466ed8fcbde22e88de81ad89340066e46f82110cf953218e`.
The temporary test container and image are removed after validation; no container was published.

## Delivery limits

The CI template remains under `docs/ci/`. Installing it as a GitHub Actions workflow requires an
authorized credential with workflow-write permission; the current credential lacks that scope.
No required CI status checks are claimed until the workflow is active and has passed remotely.
Dependabot update jobs do not count as this project's test CI.

The `v0.1.0` tag is unchanged. These checks do not certify live provider accounts, durable EventStore
recovery, distributed flow control, or internet-facing authentication. Major TypeScript, Node type,
and further test-tool upgrades remain separate compatibility work.
