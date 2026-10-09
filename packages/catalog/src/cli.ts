#!/usr/bin/env node
import { assertSafeBaseUrl, readJsonLimited } from "@model-runtime/core";
import type { ProviderManifest } from "@model-runtime/protocol";
import {
  createCatalogSnapshot,
  diffCatalog,
  parseCatalogSnapshot,
  discoverModels,
  discoveryRadar,
  parseDiscoverySnapshot,
  pollDiscovery,
  readLocalJson,
  type DiscoveryProvider,
} from "./index.js";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "snapshot" && args.length === 1) {
    const url = args[0];
    if (!url) usage();
    const target = safeCatalogUrl(url);
    const response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Provider catalog request failed");
    }
    const body = (await readJsonLimited(response, 4 * 1024 * 1024)) as {
      data?: ProviderManifest[];
    };
    if (!Array.isArray(body.data)) throw new Error("Provider catalog response is invalid");
    process.stdout.write(`${JSON.stringify(createCatalogSnapshot(body.data), null, 2)}\n`);
  } else if (command === "diff" && args.length === 2) {
    const [beforePath, afterPath] = args;
    if (!beforePath || !afterPath) usage();
    const before = parseCatalogSnapshot(await readLocalJson(beforePath));
    const after = parseCatalogSnapshot(await readLocalJson(afterPath));
    process.stdout.write(`${JSON.stringify(diffCatalog(before, after), null, 2)}\n`);
  } else if (
    (command === "discover" && args.length === 3) ||
    (command === "poll" && args.length === 4)
  ) {
    const [provider, environment, scope, directory] = args;
    if (
      !provider ||
      !["openai", "anthropic"].includes(provider) ||
      !environment ||
      !/^[A-Z][A-Z0-9_]{1,127}$/.test(environment) ||
      !scope
    )
      usage();
    const options = {
      provider: provider as DiscoveryProvider,
      scope,
      apiKey: () => {
        const value = process.env[environment];
        if (!value) throw new Error("Discovery credential is unavailable");
        return value;
      },
    };
    const result =
      command === "poll"
        ? await pollDiscovery({ ...options, directory: directory! })
        : await discoverModels(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "radar" && (args.length === 1 || args.length === 2)) {
    const current = parseDiscoverySnapshot(await readLocalJson(args.at(-1)!));
    const previous =
      args.length === 2 ? parseDiscoverySnapshot(await readLocalJson(args[0]!)) : undefined;
    process.stdout.write(`${JSON.stringify(discoveryRadar(current, previous), null, 2)}\n`);
  } else {
    usage();
  }
} catch {
  process.stderr.write(
    "Catalog operation failed; no verified result is available. Check source access, input integrity and private state permissions.\n",
  );
  process.exitCode = 1;
}

function safeCatalogUrl(value: string): URL {
  const url = assertSafeBaseUrl(value);
  return new URL("v1/providers", url.href.endsWith("/") ? url : new URL(`${url.href}/`));
}

function usage(): never {
  process.stderr.write(
    "Usage:\n  model-runtime-catalog snapshot BASE_URL\n  model-runtime-catalog diff BEFORE.json AFTER.json\n  model-runtime-catalog discover openai|anthropic API_KEY_ENV SCOPE\n  model-runtime-catalog radar [BEFORE.json] AFTER.json\n  model-runtime-catalog poll openai|anthropic API_KEY_ENV SCOPE PRIVATE_STATE_DIR\n",
  );
  process.exit(2);
}
