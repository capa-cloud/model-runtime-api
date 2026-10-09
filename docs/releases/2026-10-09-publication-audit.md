# Publication Audit Verification

As of 2026-10-09. Product baseline: `1481a842120f6415e8e8e668d13a67312c87d0e6`.
This is a bounded disclosure audit and scanner hardening checkpoint, not a versioned release.

## Audited Scope

| Surface | Observed result |
| --- | --- |
| Complete reachable Git graph | 21 commits, 323 unique blobs, 327 blob/path versions; no blocking matches |
| Branch/tag/PR coverage | Main, all three current dependency branches, all nine public PR head refs and the annotated release tag fetched/read |
| Current hosted metadata | One release, nine issue/PR records, six issue comments; review/review-comment/commit-comment lists empty; no blocking matches |
| Unsupported hosted surfaces | Wiki and Discussions disabled; no release assets present |
| Images | Four existing editorial JPEGs visually rechecked; no text, dashboard, account or organization information observed |
| Private contextual checks | External literal policy applied without publishing its values; no matches |
| Clean-room supporting evidence | In-memory whole-file source comparison found no matches; private inventories are not published |

The source comparison uses nontrivial source files and normalized line endings. It does not detect
partial or rewritten copies and is not a substitute for semantic provenance review. Hosted scans
observe current records across a read window, not deleted comments, earlier edits or third-party
caches. Private context remains outside this repository.

## Fixed Gate Behavior

- Scan staged blobs as well as current files; an uncommitted cleanup cannot hide sensitive index data.
- Remove silent size/read failures. Inspect inputs through 8 MiB, bound total work, decode UTF-16
  BOM text, reject unsafe filenames/nonregular files and require separate opaque-artifact review.
- Scan every reachable historical file version, commit metadata, ref metadata and annotated tag.
- Refuse shallow histories, changing HEAD/ref/index inventories, incomplete hosted pagination,
  unsupported hosted assets/surfaces and unsafe diagnostic environments.
- Use the fixed Secretlint recommended preset in memory. Findings expose categories/location
  hashes/object IDs, never matched strings, private policy values, email values or raw bodies.
- Include scanner regressions in `pnpm check`; keep standalone historical/hosted commands explicit.

## Fresh Checks

| Check | Result |
| --- | --- |
| Complete Node.js 24 `pnpm check` | Passed: 173 product tests, SDKs, types/build, 15 scanner tests, fixture certification, schema/docs and publication scan |
| Final index-freeze refinement | All 16 scanner regression tests passed; final contextual index/worktree scan passed |
| Node.js 22 detector compatibility | Isolated network-disabled container passed detection/redacted-diagnostic/clean-content smoke |
| Disclosure checks | Fixed preset plus generic/private-context checks found no blocking matches in inspected scope |
| Dependency audit | No known vulnerabilities; detector adapter already existed transitively and is now pinned directly |

An earlier full run under concurrent local load hit several CLI test observation deadlines. A
serial diagnostic narrowed the remaining failure to multiple independent process starts grouped
inside one five-second test budget. Those input equivalence classes now have separate tests;
no original assertion, per-process timeout, cancellation deadline or shutdown limit was relaxed.
The complete gate was rerun successfully. The final index guard was added afterward and verified
with its focused suite and a fresh index/worktree scan rather than overstating a second full run.

## Author Metadata And Limits

Six older commits have noncanonical author/committer identity metadata. These are separate hygiene
warnings, not detected provider credentials or organization-marker matches. Their values are not
copied into this report. New commits use the public GitHub noreply identity. Historical metadata,
tags and PR history were not rewritten; operator disposition remains separate from scanner results.

No detected matches is not an absolute privacy guarantee. Media meaning, source attribution,
historical identity policy, inaccessible hosted versions and future release artifacts need their
own evidence. See the [publication audit guide](../security/publication-audit.md).

The [delivery checklist](../delivery.md) still requires active CI, dependency-PR compatibility
disposition, authorized real-account certification and final cold-start/release-artifact gates.
No new version, container or production deployment is claimed by this checkpoint.
