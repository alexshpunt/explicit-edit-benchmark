import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalIdentityJson } from "./official-identities.mjs";

const REGISTRY_FILE = fileURLToPath(new URL("../registries/models/v1.json", import.meta.url));
const ID = /^[a-z0-9][a-z0-9._-]*$/u;

function validateRegistry(registry) {
  if (registry?.schemaVersion !== 1 || typeof registry.registryId !== "string")
    throw Error("Unsupported model registry");
  const routes = new Set();
  for (const model of registry.models ?? []) {
    if (!ID.test(model.id) || typeof model.displayName !== "string" || !model.displayName)
      throw Error("Invalid canonical model identity");
    for (const alias of model.providerAliases ?? []) {
      if ((alias.from !== null && !ID.test(alias.from)) || !ID.test(alias.to))
        throw Error("Invalid model provider alias");
    }
    for (const route of model.routes ?? []) {
      const key = `${route.provider}/${route.selector}`;
      if (routes.has(key)) throw Error(`Duplicate model route: ${key}`);
      routes.add(key);
    }
  }
  return registry;
}

/** Load the immutable model identity registry shipped with this runner revision. */
export async function loadModelRegistry() {
  return validateRegistry(JSON.parse(await readFile(REGISTRY_FILE, "utf8")));
}

/** Return a model's canonical inference provider, or preserve the observed provider. */
export function canonicalModelProvider(registry, modelFamily, observedProvider) {
  const id = String(modelFamily).split("/").at(-1);
  const model = registry.models.find((candidate) => candidate.id === id);
  return (
    model?.providerAliases?.find((alias) => alias.from === observedProvider)?.to ?? observedProvider
  );
}

/** Project a registered alias without changing wire selectors or explicit historical identities. */
export function canonicalModelRow(registry, row) {
  const provider = canonicalModelProvider(
    registry,
    row.modelFamily ?? row.model,
    row.provider ?? null,
  );
  const projected = { ...row, provider };
  if (typeof row.model !== "string") return projected;
  const qualified = row.model.includes("/");
  if (qualified && !row.model.startsWith(`${row.provider}/`)) return projected;
  const selector = qualified ? row.model.slice(row.model.indexOf("/") + 1) : row.model;
  const match = registry.models.find((model) =>
    model.routes?.some((route) => route.provider === row.provider && route.selector === selector),
  );
  if (!match || row.modelFamily !== selector) return projected;
  return {
    ...projected,
    modelFamily: match.id,
    ...(row.modelVersion === selector ? { modelVersion: match.id } : {}),
  };
}

/** Resolve a provider selector while preserving the exact selector used on the wire. */
export async function resolveCanonicalModel(provider, selector) {
  const registry = await loadModelRegistry();
  const match = registry.models.find((model) =>
    model.routes.some((route) => route.provider === provider && route.selector === selector),
  );
  const model = match ?? { id: selector, displayName: selector, sourceUrl: null };
  return {
    canonicalModel: {
      id: model.id,
      displayName: model.displayName,
      sourceUrl: model.sourceUrl,
    },
    modelRegistry: {
      id: registry.registryId,
      sha256: createHash("sha256").update(canonicalIdentityJson(registry)).digest("hex"),
    },
  };
}
