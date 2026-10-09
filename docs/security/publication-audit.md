# Publication Audit

The public-data gate scans both staged Git objects and current tracked/untracked nonignored files.
Cleaning a working file cannot hide a sensitive staged version. The fixed Secretlint recommended
preset is applied through its programmatic API, without repository ignore rules or historical
configuration disabling detection. Generic disclosure checks and dangerous-filename checks run too.

```bash
pnpm check:public-audit
pnpm scan:public
pnpm scan:history
pnpm scan:hosted capa-cloud/model-runtime-api
```

Build/test/artifact verification and live provider certification remain separate gates. These
commands are read-only: they do not remove files, rewrite history, change refs, force-push or
rotate credentials. Run scans after staging, and rerun when candidate content or references change.

## Coverage

| Command | Evidence scanned | Important limit |
| --- | --- | --- |
| `scan:public` | Complete staged blobs plus current tracked/untracked files | Ignored files are outside publication inventory |
| `scan:history` | Every reachable commit, blob/path version, ref name and annotated tag | Full nonshallow history and all intended refs must be present |
| `scan:hosted` | Current repository metadata, releases, issues/PRs, comments and PR review bodies | Requires logged-in `gh`; not deleted content or cached historical edits |

History refuses shallow clones and changed HEAD/ref inventories. Public filenames use NUL-delimited
Git records, so newline/control characters cannot silently split enumeration. Nonregular files,
symlinks, merge conflicts, missing tracked files and over-limit inputs fail rather than disappear
from coverage. UTF-16 BOM text is decoded before detector matching.

Limits are 8 MiB per input, 512 MiB per scan, 10000 commits and 1000 refs. Archives, PDFs and compiled
opaque binaries require separate artifact review and block the ordinary gate. Hosted release assets,
enabled Wiki/Discussions or malformed pagination also require a separate supported audit route.
Current project media are separately inspected visually: plaintext scans cannot inspect pixels,
steganography, compressed metadata or the meaning of every diagram.

## Private Context

A private literal policy can add organization-specific terms without shipping those terms in the
public repository. Keep the JSON file outside the repository and any public artifact directory:

```json
{ "literals": ["your-organization-marker"] }
```

```bash
export PUBLIC_SCAN_PRIVATE_POLICY="$HOME/.config/model-runtime/private-audit-policy.json"
pnpm scan:history
```

The policy contains at most 128 literal strings, not executable regexes. Matching is case-insensitive
against filenames/metadata/content. Policy values and paths are not printed. Inputs are not copied
to staging or written into forensic exports. Detectors process Git content in memory.

Disable `DEBUG`, `NODE_DEBUG` and `NODE_DEBUG_NATIVE` before scanning: diagnostic logging can expose
payloads or the inherited environment, so the CLI refuses those settings before loading detectors.

## Read Results

Successful commands emit structured `public-audit/1` JSON. Findings include only categories,
location hashes, Git object IDs, line information and policy indices, never excerpts or matched
values. Private paths, emails and body content are not exported. Exit 0 means no detected blocking
findings; 1 means findings; 2 means the audit could not complete. A metadata warning is not proof of
a secret: historical noncanonical author identities require separate human disposition.

SHA-256 location hashes and scanned byte counts support reproducibility, not anonymity or proof
that all possible private information is absent. Scanners are heuristic. Semantic source review,
visual media review, scope completeness and artifact inspection remain necessary. A private-source
whole-file fingerprint comparison can support clean-room evidence but does not detect partial or
rewritten copies and must not publish private source inventories.

Before reporting a release clean, freeze its SHA, fetch all intended public branch/tag/PR refs,
verify current hosted surfaces, review warnings and run the release artifact gate. Merely deleting
a file from HEAD does not remove earlier commits or hosted PR copies. Any history rewrite needs
an explicit scope, backup/recovery plan and authorization; this tool never performs one.
