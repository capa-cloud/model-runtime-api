# Model discovery verification

As of 2026-10-09. Reviewed base: `81fa5c33337ffb2c6728d57d4d43d2e250c9dc04`.
This checkpoint adds runnable inventory discovery/radar and safer catalog tooling. It does not
certify real-account model access, model quality or globally current release announcements.

## Delivered behavior

- OpenAI/Anthropic public model-list readers with projected IDs/creation metadata, bounded reads,
  deadline/cancellation handling and complete Anthropic pagination. No credentials or raw bodies
  are persisted, and HTTP redirects are never followed.
- Separate discovery snapshots and visibility radar. First observation is a baseline, not a
  mass-release alert. Comparisons require the same provider/scope and chronological observations.
- Private single-shot polling with writer ownership, 0700/0600 permissions, no symlink reads,
  fsynced atomic snapshot/report replacement and a 4 MiB state cap. Incomplete fetches, corrupt
  baselines and pre-replacement failures do not advance the last complete state.
- Validated runtime catalog metadata and digests, stable canonical ordering and sanitized CLI
  errors. Valid original snapshot digests remain usable; ordering alone cannot create a false change.
- Root `pnpm catalog` command, runnable guides and explicit separation of discovery from capability
  registration. `.model-research` is excluded from Git and Docker context.

## Fresh evidence

| Gate | Result |
| --- | --- |
| Complete `pnpm check` on Node.js 24 | Passed: format, typecheck/build, 135 tests in 19 files, SDKs, fixture certification, schema, docs and disclosure scans |
| Node.js 22 Linux discovery compatibility | 23 focused tests passed in an isolated network-disabled container with current source/compiled packages mounted read-only |
| Go/Python SDK | Fresh Go tests and five Python tests passed |
| Provider smoke harness | Four offline fixture tests passed; no real-account provider inference or inventory calls |
| Dependency audit | No known vulnerabilities found |
| CLI integration | Child processes exercised real loopback HTTP snapshots, offline diffs/radar and failure/usage exit codes |
| Failure preservation | Rejected second pages, duplicate IDs, corrupt local state, writer overlap and oversized state could not replace the prior baseline |
| Source/secret safety | Actual loopback redirect refused; synthetic resolver/body errors redacted; final public-data/Secretlint scans passed |

The first disclosure scan rejected a synthetic basic-auth URL fixture. The fixture now constructs
the same URL through the URL API with explicitly synthetic fields; scanner rules remain enabled.
The complete gate was rerun successfully after that correction.

## Operational limits

Discovery is account-visible inventory, not global launch/retirement knowledge or an inference
capability claim. Vendor creation timestamps are not verified release dates. Pagination may span
concurrent vendor inventory changes. Generated IDs can reveal private account access/fine-tunes;
all generated reports remain private even after metadata projection.

The local polling state contains the latest report only. An external private runner must own
cadence, report retention, failure/freshness alerts, notification audience and delivery guarantees.
No schedule, routing change, notification or hosted radar was installed. No fal inventory reader,
distributed locking, real-account certification or new container/release artifact is claimed.

See the [discovery guide](../guides/model-discovery.md) and [delivery checklist](../delivery.md).
Scenario evaluation/recommendation, release-candidate history audit, active CI, dependency review,
real-account verification and final packaging/cold-start gates remain open. GitHub OAuth scopes
were rechecked and still do not include workflow-write permission.
