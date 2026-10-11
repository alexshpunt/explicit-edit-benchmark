import { createHash } from "node:crypto";
import { neutralSourcePath, assertNeutralSource } from "../generation/origin-markers.mjs";

const categories = ["locals-parameters", "fields", "functions-types"];
const roles = {
  "locals-parameters": new Set(["local", "parameter", "variable"]),
  fields: new Set(["field"]),
  "functions-types": new Set(["function", "type"]),
};
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function safePath(file) {
  if (
    typeof file !== "string" ||
    file.startsWith("/") ||
    file.includes("\\") ||
    file.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    throw new Error(`Unsafe source path: ${file}`);
}
function functionOwner(scope) {
  const parts = scope.split("::");
  const index = parts.findIndex((part) => /@\d+$/.test(part) && !part.startsWith("anonymous@"));
  if (index < 0) throw new Error(`Missing function owner: ${scope}`);
  return parts.slice(0, index + 1).join("::");
}
function targetGroups(record, neutral) {
  const families = new Map();
  for (const entry of record.selection) {
    if (!roles[record.category].has(entry.role))
      throw new Error(`Unsupported naming role: ${entry.role}`);
    if (
      !identifier.test(entry.name) ||
      !identifier.test(entry.newName) ||
      !entry.family ||
      typeof entry.scope !== "string" ||
      !Number.isInteger(entry.offset) ||
      entry.offset < 0
    )
      throw new Error("Incomplete naming target");
    const id = neutral(entry.family);
    if (!families.has(id))
      families.set(id, {
        id,
        role: entry.role,
        from: entry.newName,
        to: entry.name,
        sites: [],
      });
    const family = families.get(id);
    if (family.role !== entry.role || family.from !== entry.newName || family.to !== entry.name)
      throw new Error(`Conflicting family: ${id}`);
    const scope = neutral(entry.scope);
    const owner =
      entry.role === "local" || entry.role === "parameter"
        ? functionOwner(scope)
        : entry.role === "field"
          ? scope
          : id;
    if (family.sites.some((site) => site.offset === entry.offset))
      throw new Error(`Duplicate naming site: ${id}`);
    family.sites.push({
      offset: entry.offset,
      scope,
      owner,
      ...(entry.owner
        ? {
            selector: {
              kind: entry.owner.kind,
              scope: neutral(entry.owner.scope ?? ""),
              signature: neutral(entry.owner.signature ?? ""),
            },
          }
        : {}),
    });
  }
  // One physical template binding can couple parameters declared in different owners.
  // Merge only owner groups connected by a recorded family, not by matching spellings.
  const parents = new Map();
  const leader = (value) => {
    if (!parents.has(value)) parents.set(value, value);
    const parent = parents.get(value);
    if (parent === value) return value;
    const root = leader(parent);
    parents.set(value, root);
    return root;
  };
  for (const family of families.values()) {
    const owners = family.sites.map((site) => site.owner).sort(order);
    for (const owner of owners) {
      const a = leader(owners[0]),
        b = leader(owner);
      if (a !== b) parents.set(order(a, b) < 0 ? b : a, order(a, b) < 0 ? a : b);
    }
  }
  for (const edit of record.edits ?? []) {
    if (!edit.families) continue;
    const owners = edit.families.flatMap((id) => {
      const family = families.get(neutral(id));
      if (!family) throw new Error("Unknown physical binding family");
      if (family.from !== edit.new || family.to !== edit.old)
        throw new Error("Conflicting physical binding target");
      return family.sites.map((site) => site.owner);
    });
    for (const owner of owners) {
      const a = leader(owners[0]),
        b = leader(owner);
      if (a !== b) parents.set(order(a, b) < 0 ? b : a, order(a, b) < 0 ? a : b);
    }
  }
  const grouped = new Map();
  for (const family of families.values()) {
    family.sites.sort((a, b) => a.offset - b.offset);
    const owner = leader(family.sites[0].owner);
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(family);
  }
  return [...grouped.values()]
    .map((items) => {
      items.sort((a, b) => order(a.id, b.id));
      const owners = [...new Set(items.flatMap((item) => item.sites.map((site) => site.owner)))];
      owners.sort(order);
      const id = createHash("sha256")
        .update(JSON.stringify([record.category, owners]))
        .digest("hex");
      return { id, category: record.category, owners, families: items };
    })
    .sort((a, b) => order(a.owners[0], b.owners[0]));
}

/** Inventory every restoration target from the pinned generation records.
 * This is private planning metadata, not agent requests or a verified full route.
 * Locals group by function owner, fields by type owner, and globals by bound family.
 * Compiler-coupled owners stay together; excluded declarations were never renamed.
 */
export function restorationTargets(manifest) {
  const records = manifest?.operations;
  if (!Array.isArray(records)) throw new Error("Missing generation operations");
  const origins = records.filter((record) => record.kind === "origin-markers");
  if (origins.length !== 1 || !identifier.test(origins[0].name))
    throw new Error("Missing or ambiguous neutral origin");
  const origin = origins[0].name;
  const neutral = (text) => text.replace(/\byocto\b/g, origin);
  const sources = new Set(["main.cpp"]);
  const helpers = [];
  const layout = [];
  const named = new Map();
  for (const record of records) {
    if (record.operation) {
      const { source, target, kind, renames = {} } = record.operation;
      safePath(source);
      safePath(target);
      if (!["append", "include"].includes(kind))
        throw new Error(`Unsupported restoration operation: ${kind}`);
      const file = neutralSourcePath(source, origin);
      if (sources.has(file)) throw new Error(`Duplicate restored source: ${file}`);
      sources.add(file);
      for (const [to, from] of Object.entries(renames)) {
        if (!identifier.test(from) || !identifier.test(to))
          throw new Error("Invalid helper target");
        helpers.push({ file, from, to });
      }
    } else if (record.kind === "rename") {
      if (!categories.includes(record.category) || named.has(record.category))
        throw new Error(`Unsupported or duplicate naming category: ${record.category}`);
      if (!Array.isArray(record.selection) || !Array.isArray(record.excluded))
        throw new Error("Missing naming coverage");
      named.set(record.category, record);
    } else if (["function-declarations", "function-permutation"].includes(record.kind)) {
      if (layout.includes(record.kind)) throw new Error("Duplicate layout operation");
      layout.push(record.kind);
    } else if (!["origin-markers", "compact"].includes(record.kind))
      throw new Error(`Unsupported restoration operation: ${record.kind}`);
  }
  for (const category of categories)
    if (!named.has(category)) throw new Error(`Missing naming category: ${category}`);
  const naming = categories.flatMap((category) => targetGroups(named.get(category), neutral));
  const excluded = categories.flatMap((category) =>
    named.get(category).excluded.map((entry) => ({ category, ...entry })),
  );
  const result = {
    version: "renderer-restoration-targets-v1",
    origin,
    sources: [...sources].sort(order),
    helpers: helpers.sort((a, b) => order(a.file, b.file) || order(a.from, b.from)),
    layout,
    naming,
    excluded,
    counts: {
      selectionSites: naming.reduce(
        (sum, group) =>
          sum + group.families.reduce((count, family) => count + family.sites.length, 0),
        0,
      ),
      families: naming.reduce((sum, group) => sum + group.families.length, 0),
    },
  };
  assertNeutralSource("targets", JSON.stringify(result));
  return result;
}
