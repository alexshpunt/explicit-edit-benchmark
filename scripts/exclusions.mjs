import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ID = /^[a-z0-9][a-z0-9-]*$/u;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys))
    throw Error(`${label} fields: expected ${keys.join(", ")}; got ${actual.join(", ")}`);
}

/** Validate the repository-owned, versioned exclusion registry. */
export function validateExclusionRegistry(registry) {
  exactKeys(registry, ["schemaVersion", "policyId", "decisions"], "registry");
  if (
    registry.schemaVersion !== 1 ||
    !/^benchmark-exclusions-v[1-9][0-9]*$/u.test(registry.policyId)
  )
    throw Error("registry: unsupported schema or policy identity");
  if (!Array.isArray(registry.decisions)) throw Error("registry.decisions: expected array");
  const ids = new Set();
  for (const [index, decision] of registry.decisions.entries()) {
    const label = `registry.decisions[${index}]`;
    exactKeys(decision, ["id", "status", "scope", "selector", "reason", "decisionRevision"], label);
    if (!ID.test(decision.id) || ids.has(decision.id)) throw Error(`${label}: invalid id`);
    ids.add(decision.id);
    if (!["active", "withdrawn"].includes(decision.status)) throw Error(`${label}: invalid status`);
    if (decision.scope !== "canonical-comparisons") throw Error(`${label}: invalid scope`);
    if (typeof decision.reason !== "string" || !decision.reason.trim())
      throw Error(`${label}: reason is required`);
    if (!COMMIT.test(decision.decisionRevision)) throw Error(`${label}: invalid decision revision`);
    if (decision.selector?.kind === "configuration") {
      exactKeys(decision.selector, ["kind", "configurationHash"], `${label}.selector`);
      if (!SHA256.test(decision.selector.configurationHash))
        throw Error(`${label}: invalid configuration hash`);
    } else if (decision.selector?.kind === "package") {
      exactKeys(
        decision.selector,
        ["kind", "name", "version", "digestSha256"],
        `${label}.selector`,
      );
      if (
        typeof decision.selector.name !== "string" ||
        !decision.selector.name ||
        typeof decision.selector.version !== "string" ||
        !decision.selector.version ||
        !SHA256.test(decision.selector.digestSha256)
      )
        throw Error(`${label}: invalid exact package identity`);
    } else {
      throw Error(`${label}: unsupported selector`);
    }
  }
  return registry;
}

/** Read and validate an exclusion registry from disk. */
export async function loadExclusionRegistry(file) {
  return validateExclusionRegistry(JSON.parse(await readFile(file, "utf8")));
}

/** Return a stable revision for a validated registry. */
export function exclusionPolicyRevision(registry) {
  validateExclusionRegistry(registry);
  return createHash("sha256").update(JSON.stringify(registry)).digest("hex");
}

function matchingDecision(profile, decisions) {
  return decisions.find((decision) => {
    const selector = decision.selector;
    if (selector.kind === "configuration")
      return profile.configurationHash === selector.configurationHash;
    return (profile.packages ?? []).some(
      (item) =>
        item.name === selector.name &&
        item.version === selector.version &&
        item.digestSha256 === selector.digestSha256,
    );
  });
}

/**
 * Remove active exclusions from derived comparison inputs without mutating raw evidence.
 * The returned `applied` list is suitable for publishing beside the derived views.
 */
export function applyExclusions(registry, evidence) {
  validateExclusionRegistry(registry);
  const decisions = registry.decisions.filter((decision) => decision.status === "active");
  const applied = [];
  const excludedProfiles = new Set();
  const profiles = (evidence.profiles ?? []).filter((profile) => {
    const decision = matchingDecision(profile, decisions);
    if (!decision) return true;
    excludedProfiles.add(`${profile.runId}::${profile.profileId}`);
    applied.push({
      decisionId: decision.id,
      runId: profile.runId,
      profileId: profile.profileId,
      configurationHash: profile.configurationHash,
    });
    return false;
  });
  const trials = (evidence.trials ?? []).filter(
    (trial) => !excludedProfiles.has(`${trial.runId}::${trial.profileId}`),
  );
  const trialKeys = new Set(trials.map((trial) => `${trial.runId}::${trial.trialId}`));
  const rounds = (evidence.rounds ?? []).filter((round) =>
    trialKeys.has(`${round.runId}::${round.trialId}`),
  );
  const roundKeys = new Set(rounds.map((round) => `${round.runId}::${round.roundId}`));
  const toolCalls = (evidence.toolCalls ?? []).filter((call) =>
    roundKeys.has(`${call.runId}::${call.roundId}`),
  );
  return { profiles, trials, rounds, toolCalls, applied };
}
