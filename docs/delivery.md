# Delivery checklist

As of 2026-10-09. This checklist tracks the remaining work toward final delivery; a checked
implementation item does not substitute for a verified release or live provider certification.

## Runtime and client acceptance

- [x] Partial-output fallback suppression and explicit fallback policy
- [x] Bounded fal cleanup and duplicate-submission prevention
- [x] Standards-compliant, bounded SSE parsing shared by providers and TypeScript clients
- [x] Cancellation and cleanup when consumers stop reading responses
- [x] Provider credentials cannot follow redirects to an unconfigured destination
- [x] Server streaming respects backpressure and contains asynchronous failures
- [x] Orderly shutdown cancels active work and closes streams within a bounded grace period
- [x] Resource retention and restart/recovery behavior are explicit and validated (local single-writer profile)
- [x] Provider capability claims and configuration match supported adapter behavior (declarations, not live certification)
- [ ] Model discovery/radar and scenario-evaluation workflows are runnable and documented

## Verification and publication

- [x] Fresh complete local gate and Node.js 22/24 compatibility evidence (current checkpoint)
- [ ] Complete public-content/history audit for the release candidate, including new artifacts
- [ ] Active GitHub CI with dependency audits, container verification and required checks
- [ ] Remaining dependency PRs resolved through compatibility evidence
- [x] Independently runnable provider-certification harness with sanitized evidence (protocol smoke only)
- [ ] Real-account adapter certification using authorized public-project credentials
- [ ] Reproducible release artifacts and a new versioned release with verification evidence
- [ ] Final documentation and cold-start installation/run check from a clean checkout

## Constraints

The latest scoped checkpoint is [model capability declarations](releases/2026-10-09-capability-verification.md).
The complete Node.js 22/24 baseline is [bounded storage and restart recovery](releases/2026-10-09-storage-verification.md).
Future runtime changes must rerun the relevant gates before these results support a release.

The reference runtime remains behind an authenticated gateway or on loopback. Tenant management,
customer billing and a hosted SaaS gateway remain outside the owning project's contract. Public
content must use public sources and synthetic fixtures; private implementation, accounts,
credentials, routing policy, logs and business data are excluded.

The current GitHub credential lacks workflow-write permission. Live certification also requires
dedicated, authorized public-project provider credentials; private-system credentials are not a
substitute. These are open delivery gates, not completed or silently waived checks.
