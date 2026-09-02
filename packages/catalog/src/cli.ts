#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { ProviderManifest } from "@model-runtime/protocol";
import { createCatalogSnapshot, diffCatalog, type CatalogSnapshot } from "./index.js";

const [command, ...args] = process.argv.slice(2);

if (command === "snapshot") {
  const url = args[0];
  if (!url) usage();
  const target = safeCatalogUrl(url);
  const response = await fetch(target);
  if (!response.ok)
    throw new Error(`Provider catalog request failed with status ${response.status}`);
  const body = (await response.json()) as { data?: ProviderManifest[] };
  if (!Array.isArray(body.data)) throw new Error("Provider catalog response is invalid");
  process.stdout.write(`${JSON.stringify(createCatalogSnapshot(body.data), null, 2)}\n`);
} else if (command === "diff") {
  const [beforePath, afterPath] = args;
  if (!beforePath || !afterPath) usage();
  const before = JSON.parse(await readFile(beforePath, "utf8")) as CatalogSnapshot;
  const after = JSON.parse(await readFile(afterPath, "utf8")) as CatalogSnapshot;
  process.stdout.write(`${JSON.stringify(diffCatalog(before, after), null, 2)}\n`);
} else {
  usage();
}

function safeCatalogUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Catalog URL must be HTTPS or loopback HTTP");
  }
  return new URL("v1/providers", url.href.endsWith("/") ? url : new URL(`${url.href}/`));
}

function usage(): never {
  process.stderr.write(
    "Usage:\n  model-runtime-catalog snapshot BASE_URL\n  model-runtime-catalog diff BEFORE.json AFTER.json\n",
  );
  process.exit(2);
}
