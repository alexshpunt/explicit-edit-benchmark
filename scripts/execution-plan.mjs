import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentityJson } from "./official-identities.mjs";
import { adapterDefinition } from "./adapter-registry.mjs";
import { resolveCanonicalModel } from "./model-registry.mjs";

const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OFFICIAL_REGISTRY_URL = "https://registry.npmjs.org";

const OAUTH_SCHEMA = {
  required: ["type", "access", "refresh", "expires", "accountId"],
  allowed: ["type", "access", "refresh", "expires", "accountId"],
  type: "oauth",
};

const API_KEY_SCHEMA = {
  required: ["type", "key"],
  allowed: ["type", "key"],
  type: "api_key",
};

const PROVIDER_CREDENTIAL_SCHEMAS = {
  "openai-codex": OAUTH_SCHEMA,
  deepseek: API_KEY_SCHEMA,
  zai: API_KEY_SCHEMA,
  xiaomi: API_KEY_SCHEMA,
  "opencode-go": API_KEY_SCHEMA,
  opencode: API_KEY_SCHEMA,
};

/** Resolve package evidence for the canonical adapter selected by either transport. */
function adapterRecipe(id) {
  let adapter;
  try {
    adapter = adapterDefinition(id);
  } catch {
    return null;
  }
  return {
    ...adapter,
    harnessFamily: id,
    packages: [
      { role: "agent", name: adapter.package, versionInput: "agentVersion" },
      ...(adapter.extensionPackage
        ? [{ role: "extension", name: adapter.extensionPackage, versionInput: "harnessVersion" }]
        : []),
      ...(adapter.runtimePackage
        ? [{ role: "runtime", name: adapter.runtimePackage, versionInput: "runtimeVersion" }]
        : []),
    ],
    providers: Object.keys(PROVIDER_CREDENTIAL_SCHEMAS),
    credentialSchemas: PROVIDER_CREDENTIAL_SCHEMAS,
  };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(`${label}: expected fields ${expected.join(", ")}; got ${actual.join(", ")}`);
}

function exactVersion(value, label) {
  if (typeof value !== "string" || !EXACT_VERSION.test(value))
    throw Error(`${label}: an exact semantic version is required`);
  return value;
}

function validateInput(input) {
  const adapter = adapterRecipe(input?.adapter);
  if (!adapter) throw Error(`Unknown adapter: ${input?.adapter}`);
  const fields = ["adapter", "agentVersion", "provider", "model", "reasoning"];
  if (adapter.extensionPackage) fields.push("harnessVersion");
  if (adapter.runtimePackage) fields.push("runtimeVersion");
  exactKeys(input, fields, "official input");
  exactVersion(input.agentVersion, "agentVersion");
  if (input.harnessVersion !== undefined) exactVersion(input.harnessVersion, "harnessVersion");
  if (input.runtimeVersion !== undefined) exactVersion(input.runtimeVersion, "runtimeVersion");
  if (!adapter.providers.includes(input.provider))
    throw Error(`Unsupported provider: ${input.provider}`);
  if (!MODEL.test(input.model) || !input.model.startsWith(`${input.provider}/`))
    throw Error("model: exact provider-qualified model id required");
  if (!["off", "low", "medium", "high", "max"].includes(input.reasoning))
    throw Error(`Unsupported reasoning level: ${input.reasoning}`);
  return adapter;
}

async function npmPackage(name, version, fetchImpl) {
  const url = `${OFFICIAL_REGISTRY_URL}/${encodeURIComponent(name)}/${version}`;
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok)
    throw Error(`npm package resolution failed: ${name}@${version} (${response.status})`);
  const metadata = await response.json();
  if (metadata.name !== name || metadata.version !== version)
    throw Error(`npm package identity mismatch: ${name}@${version}`);
  if (
    typeof metadata.dist?.integrity !== "string" ||
    !metadata.dist.integrity.startsWith("sha512-")
  )
    throw Error(`npm package has no sha512 integrity: ${name}@${version}`);
  const tarball = new URL(metadata.dist.tarball);
  if (tarball.protocol !== "https:" || tarball.hostname !== "registry.npmjs.org")
    throw Error(`npm package has forbidden tarball origin: ${name}@${version}`);
  const dependencies = metadata.dependencies ?? {};
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))
    throw Error(`npm package has invalid dependencies: ${name}@${version}`);
  return {
    role: null,
    name,
    version,
    integrity: metadata.dist.integrity,
    tarball: tarball.href,
    declaredDependencyFingerprint: createHash("sha256")
      .update(canonicalIdentityJson(dependencies))
      .digest("hex"),
  };
}

/** Resolve caller data to an immutable, declarative execution plan before inference starts. */
export async function resolveExecutionPlan(input, options = {}) {
  const adapter = validateInput(input);
  const fetchImpl = options.fetch ?? fetch;
  const selector = input.model.slice(input.model.indexOf("/") + 1);
  const modelIdentity = await resolveCanonicalModel(input.provider, selector);
  const packages = [];
  for (const recipe of adapter.packages) {
    const resolved = await npmPackage(recipe.name, input[recipe.versionInput], fetchImpl);
    packages.push({ ...resolved, role: recipe.role });
  }
  const identity = {
    adapter: input.adapter,
    agentFamily: adapter.agentFamily,
    harnessFamily: adapter.harnessFamily,
    provider: input.provider,
    model: input.model,
    ...modelIdentity,
    reasoning: input.reasoning,
    packages,
  };
  return {
    schemaVersion: 1,
    ...identity,
    credential: {
      provider: input.provider,
      fields: adapter.credentialSchemas[input.provider].allowed,
    },
    planHash: createHash("sha256").update(canonicalIdentityJson(identity)).digest("hex"),
  };
}

/** Verify installed root packages and fingerprint the complete npm lock resolution. */
export async function installedDependencyFingerprint(runtimeDirectory, plan) {
  const lock = JSON.parse(
    await readFile(path.join(path.resolve(runtimeDirectory), "package-lock.json"), "utf8"),
  );
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object")
    throw Error("installed dependency tree requires package-lock v3");
  for (const expected of plan.packages) {
    const installed = lock.packages[`node_modules/${expected.name}`];
    if (installed?.version !== expected.version || installed?.integrity !== expected.integrity)
      throw Error(`installed package does not match plan: ${expected.name}@${expected.version}`);
  }
  const packages = Object.entries(lock.packages)
    .filter(([location]) => location)
    .map(([location, installed]) => {
      if (installed.link === true)
        throw Error(`installed dependency may not be a link: ${location}`);
      const resolved = installed.resolved ?? null;
      if (
        resolved !== null &&
        (!URL.canParse(resolved) || new URL(resolved).hostname !== "registry.npmjs.org")
      )
        throw Error(`installed dependency has forbidden origin: ${location}`);
      if (typeof installed.version !== "string" || !EXACT_VERSION.test(installed.version))
        throw Error(`installed dependency has invalid version: ${location}`);
      return {
        location,
        version: installed.version,
        resolved,
        integrity: installed.integrity ?? null,
      };
    })
    .sort((left, right) => left.location.localeCompare(right.location));
  return {
    packageCount: packages.length,
    fingerprint: createHash("sha256").update(canonicalIdentityJson(packages)).digest("hex"),
    packages,
  };
}

/** Copy only the selected provider credential and reject embedded runtime configuration. */
export function selectOfficialCredential(store, plan) {
  if (!store || typeof store !== "object" || Array.isArray(store))
    throw Error("credential store: expected object");
  const schema = adapterRecipe(plan.adapter)?.credentialSchemas[plan.provider];
  if (!schema) throw Error("credential schema does not match execution plan");
  const credential = store[plan.provider];
  exactKeys(credential, schema.allowed, `${plan.provider} credential`);
  for (const field of schema.required)
    if (credential[field] === undefined || credential[field] === null || credential[field] === "")
      throw Error(`${plan.provider} credential: missing ${field}`);
  if (credential.type !== schema.type) throw Error(`${plan.provider} credential: unsupported type`);
  return {
    [plan.provider]: Object.fromEntries(schema.allowed.map((field) => [field, credential[field]])),
  };
}
