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

The CLI can read a runtime provider catalog or compare two snapshots:

```bash
model-runtime-catalog snapshot http://127.0.0.1:4320 > catalog.json
model-runtime-catalog diff previous.json catalog.json
```
