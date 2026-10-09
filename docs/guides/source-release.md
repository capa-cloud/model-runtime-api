# Reproducible source release

As of 2026-10-09. Preparing an artifact is not publishing a release or certifying a provider.
Follow the remaining gates in the [delivery checklist](../delivery.md) before publication.

## Prepare and independently verify

Use an exact, verified full commit SHA, not a branch name or tag. The output parent must already
exist outside the repository. The tool creates a fresh private directory and never overwrites
an existing artifact.

```bash
pnpm release:source prepare FULL_COMMIT_SHA "$RELEASE_OUTPUT_PARENT"
pnpm release:source verify FULL_COMMIT_SHA "$GENERATED_RELEASE_DIRECTORY"
```

Preparation emits the local directory and `published: false`. Verification regenerates the source
from that commit and compares all three files byte-for-byte:

| File | Meaning |
| --- | --- |
| `model-runtime-api-source.tar.gz` | Git-committed source under one `model-runtime-api/` prefix |
| `source-manifest.json` | Commit/tree identity, each source file's mode, size and SHA-256, archive digest, toolchain versions |
| `SHA256SUMS` | SHA-256 of the archive and manifest |

The manifest contains approved public relative paths, not local paths, author identities, private
scan-policy values or environment contents. Checksums detect byte differences; they are not an
independent signature or proof of provenance. Obtain the expected commit and checksum from a trusted
channel. Reproduction requires the recorded Git, Node.js and zlib versions; different compressors
or Git implementations may produce different bytes.

## Safety boundary

- Only committed regular files are eligible. Dirty working files, ignored configuration,
  dependency directories, build outputs, runtime journals and private research state are excluded.
- Each source blob passes the same public-content/secret detector as repository publication.
  `PUBLIC_SCAN_PRIVATE_POLICY` may point to an external private policy; it is never packaged.
- Symlinks, submodules, unsafe paths, archive-attribute files, nested opaque archives and excessive
  input are refused. Limits: 2,048 files, 8 MiB per file and 32 MiB total source.
- Git creates the tar. Before compression, the tool extracts only its own just-generated tar into
  a fresh temporary directory and verifies every file against the audited blob digest. Archive
  attributes cannot silently omit or substitute files. Temporary extraction is removed afterward.
- Verification does not extract a supplied archive. It regenerates trusted source and compares
  bytes, rejecting extra files, symbolic links and modified manifests/checksums/archives.
- Output is private by default: directory mode `0700`, file mode `0600`. Make deliberate publication
  decisions only after content/history/hosted audits and the release checklist are satisfied.

This is a source distribution, not a bundled application, npm package or OCI image. Installation
still needs `pnpm install --frozen-lockfile` and the documented SDK tools. A cold start must be
tested from the candidate archive, not only an existing checkout. The source archive intentionally
has no `.git` directory: run installation, build, runtime/SDK tests and startup checks there.
The full `pnpm check` also includes Git-backed document/publication inventory checks and must run
in the matching full Git checkout, not in an archive without Git metadata. Bitmap assets require visual
review in addition to pattern scanning. Full Git history, hosted comments, active CI and authorized
live-provider certification remain separate gates; this tool does not waive any of them.
