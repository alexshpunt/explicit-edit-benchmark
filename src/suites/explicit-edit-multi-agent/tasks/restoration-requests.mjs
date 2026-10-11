import { restorationTargets } from "./restoration-targets.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";

const ownerLabel = (scope) => scope.replace(/@\d+/g, "");
const common =
  "Keep earlier changes, behavior and rendered images unchanged. Keep the neutral project identity in filenames, includes, namespace and guards. Keep the project buildable, do not add comments, and leave unrelated code alone.";

function mappingFor(families) {
  const table = new Map();
  for (const family of families) {
    if (
      family.from === family.to ||
      (table.has(family.from) && table.get(family.from) !== family.to)
    )
      throw new Error("Conflicting binding name request");
    table.set(family.from, family.to);
  }
  if (!table.size) throw new Error("Empty binding name request");
  return [...table].map(([from, to]) => ({ from, to }));
}
function selectorsFor(group) {
  const selectors = new Map();
  const owners = new Map();
  for (const family of group.families) {
    for (const site of family.sites) {
      if (
        family.role === "variable" &&
        /@\d+/.test(site.scope) &&
        family.sites.some((item) => !/@\d+/.test(item.scope))
      )
        continue;
      const selector =
        family.role === "local" || family.role === "parameter"
          ? site.selector
          : family.role === "field"
            ? { kind: "record", scope: ownerLabel(site.scope) }
            : {
                kind: family.role,
                scope: [ownerLabel(site.scope), family.from].filter(Boolean).join("::"),
              };
      if (
        !selector ||
        typeof selector.scope !== "string" ||
        !selector.scope
          .split("::")
          .every((part) =>
            /^(?:[A-Za-z_]\w*|operator(?:\[\]|\(\)|[+\-*/%<>=!&|^~]+)|~[A-Za-z_]\w*)$/.test(part),
          )
      )
        throw new Error("Missing or unsafe owner selector");
      if (family.role === "local" || family.role === "parameter") {
        if (
          selector.kind !== "function" ||
          selector.scope !== ownerLabel(site.owner) ||
          typeof selector.signature !== "string" ||
          !selector.signature.includes("(") ||
          /\bat\s|[/\\]|@\d|:\d/.test(selector.signature)
        )
          throw new Error("Missing or unsafe function owner signature selector");
      }
      const key = JSON.stringify(selector);
      if (owners.has(site.owner) && owners.get(site.owner) !== key)
        throw new Error("Conflicting owner selectors");
      owners.set(site.owner, key);
      selectors.set(key, selector);
    }
  }
  return [...selectors.values()];
}
function prompt(target, mapping, selectors = [], file, scoped = false) {
  const where = scoped
    ? "only within the selected owners"
    : file
      ? `in file \`${file}\``
      : "throughout the project";
  const selected = selectors.length
    ? `\nOwners:\n${selectors.map((selector) => JSON.stringify(selector)).join("\n")}\nEnd owners.`
    : "";
  return `Restore the following binding names ${where}.\nTarget: ${target}.${selected} Update declarations and all uses bound to these names; keep literals and other bindings unchanged.\n\nMappings:\n${mapping.map(({ from, to }) => `${from} -> ${to}`).join("\n")}\nEnd mappings.\n\n${common}`;
}

/** Describe every naming owner/family using only current spellings and the requested names.
 * Requests follow the verified reference naming order, but contain no inverse locations,
 * source bodies or future answers. Reused spellings require distinct owner selectors;
 * unsafe or ambiguous selectors are rejected. Scoped prompts cannot use the legacy
 * spelling-wide executor. Structure requests and full workload sealing are separate.
 */
export function restorationNameRequests(manifest, { selectOwners } = {}) {
  const targets = restorationTargets(manifest);
  const spellings = new Map();
  const bindings = new Map();
  const requests = targets.naming.map((group) => {
    const mapping = mappingFor(group.families);
    const selectors = selectOwners ? selectOwners(group) : selectorsFor(group);
    if (
      !Array.isArray(selectors) ||
      !selectors.length ||
      selectors.some(
        (selector) =>
          !selector.scope ||
          /[;{}\n]/.test(selector.scope) ||
          (selector.kind === "function" &&
            group.category === "locals-parameters" &&
            !selector.signature) ||
          (selector.owner &&
            (!selector.owner.scope ||
              !selector.owner.signature ||
              /\bat\s|[/\\]|@\d|:\d/.test(selector.owner.signature))),
      )
    )
      throw new Error("Missing or unsafe prepared owner selector");
    for (const { from } of mapping) {
      if (!spellings.has(from)) spellings.set(from, new Set());
      spellings.get(from).add(group.id);
      for (const selector of selectors) {
        const key = JSON.stringify([selector, from]);
        if (bindings.has(key) && bindings.get(key) !== group.id)
          throw new Error(
            `Ambiguous owner selector across name requests: ${key} (${bindings.get(key)} versus ${group.id})`,
          );
        bindings.set(key, group.id);
      }
    }
    const owners = [...new Set(group.owners.map(ownerLabel))];
    const target =
      group.category === "locals-parameters"
        ? group.families.every((family) => family.role === "variable")
          ? `variable binding ${mapping.map(({ from }) => from).join(", ")}`
          : `parameters and locals of ${owners.join(", ")}`
        : group.category === "fields"
          ? `fields of ${owners.join(", ")}`
          : `${group.families.map((family) => `${family.role} ${ownerLabel(family.sites[0].scope)}::${family.from}`).join(", ")}`;
    return {
      phase: "names",
      target: group.id,
      category: group.category,
      mapping,
      selectors,
      prompt: prompt(target, mapping, selectors),
    };
  });
  for (const request of requests) {
    if (request.mapping.some(({ from }) => spellings.get(from).size > 1))
      request.prompt = prompt(
        "owner-specific bindings",
        request.mapping,
        request.selectors,
        undefined,
        true,
      );
  }
  for (const [index, helper] of targets.helpers.entries()) {
    const mapping = [{ from: helper.from, to: helper.to }];
    requests.push({
      phase: "names",
      target: `helper-${index + 1}`,
      category: "helpers",
      mapping,
      file: helper.file,
      prompt: prompt(`translation-unit helper ${helper.from}`, mapping, [], helper.file),
    });
  }
  assertNeutralSource("name-requests", JSON.stringify(requests));
  return requests;
}
