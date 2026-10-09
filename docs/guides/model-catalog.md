# Versioned capability catalog

`@model-runtime/catalog` snapshots provider manifests and computes deterministic diffs.

```ts
const before = createCatalogSnapshot(previousManifests, previousObservedAt);
const after = createCatalogSnapshot(currentManifests);
const diff = diffCatalog(before, after);
```

The experiment reports added, removed, and capability-changed provider/model identities. Discovery
is only a candidate signal. A new model must still pass account access, schema, smoke, usage, and
scenario evaluation before routing traffic.

Catalog snapshots contain public capability metadata only. Do not add credentials, private pricing,
customer access policy, routing weights, or private endpoints.

The CLI can read a runtime provider catalog or compare two snapshots. From a repository checkout:

```bash
pnpm build
umask 077
mkdir -p .model-research
pnpm --silent catalog snapshot http://127.0.0.1:4320 > .model-research/catalog.json
pnpm --silent catalog diff .model-research/previous-catalog.json .model-research/catalog.json
```

Build before running the CLI. Use `--silent` when saving JSON so package-manager banners cannot
contaminate the snapshot; direct `node packages/catalog/dist/cli.js` invocation also emits pure JSON.

This catalog describes **configured models**, not all models a vendor offers. Use the separate
[model discovery workflow](model-discovery.md) to poll upstream account-visible inventories.
Discovery snapshots cannot be used as capability manifests: discovery does not verify adapter
translation, endpoint availability or model quality.

Catalog metadata is validated before export or comparison. Unknown fields, duplicate provider/model
identities, unsupported protocol versions and invalid modality/capability declarations are
rejected. Provider identifiers must not contain `/`, preventing ambiguous provider/model keys.
Model identifiers may contain `/`; identifiers are bounded ASCII metadata, not display labels.
Files and HTTP bodies are bounded to 4 MiB; catalog snapshots allow at most 128 providers and
10000 models total. HTTP reads have a 30-second deadline and never follow redirects.

Object key order, provider/model ordering, and the ordering of ability/modality sets do not create
false changes. New digests use canonical ordering; structurally valid older snapshots retain their
original digest and are canonicalized for comparison. Changing model capabilities still produces
a real `changed_models` entry. SHA-256 checks accidental corruption, not source authenticity:
protect the source and local snapshot files.
