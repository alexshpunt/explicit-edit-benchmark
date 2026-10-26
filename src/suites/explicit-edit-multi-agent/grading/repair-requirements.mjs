import path from "node:path";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { byteToCharacter } from "../cpp/cpp-offsets.mjs";
import { canonicalRepairSignature } from "../cpp/repair-identity.mjs";

const identifier = (value) => typeof value === "string" && /^[A-Za-z_]\w*$/.test(value);
const qualified = (value) => (typeof value === "string" ? value.replace(/^::/, "") : "");
const parent = (value) => {
  const index = value.lastIndexOf("::");
  return index < 0 ? "" : value.slice(0, index);
};
const leaf = (value) => {
  const index = value.lastIndexOf("::");
  return index < 0 ? value : value.slice(index + 2);
};
const join = (scope, value) => [qualified(scope), value].filter(Boolean).join("::");
const relative = (file) =>
  typeof file === "string" &&
  file.length > 0 &&
  !path.posix.isAbsolute(file) &&
  !/[\x00-\x1f\x7f]/.test(file) &&
  !file.split("/").some((part) => ["", ".", ".."].includes(part));
const ownContext = (binding) => ({ file: binding.file, owner: binding.owner });

function requirements(nodes, bindings) {
  const names = [],
    nominal = [];
  let order = 0;
  for (const node of nodes)
    for (const operation of node.operations ?? []) {
      const index = order++;
      if (operation.phase !== "names") continue;
      const file = operation.category === "helpers" ? operation.file : undefined;
      if (file !== undefined && !relative(file)) continue;
      for (const mapping of operation.mapping ?? []) {
        if (!identifier(mapping.from) || !identifier(mapping.to)) continue;
        const selectors = operation.selectors?.length ? operation.selectors : [undefined];
        for (const selector of selectors) {
          let role,
            fromScope,
            owner = selector?.owner;
          if (operation.category === "helpers" && !selector) {
            names.push({ ...mapping, order: index, file, helper: true, category: "helpers" });
            // The public file restriction and current compiler declaration supply
            // scope for legacy file-helper requirements that have no selector.
            for (const binding of bindings)
              if (
                binding.file === file &&
                binding.role === "function" &&
                [mapping.from, mapping.to].includes(binding.name) &&
                (!binding.owner || binding.owner.scope === binding.scope)
              )
                nominal.push({
                  ...mapping,
                  kind: "function",
                  fromScope: join(parent(binding.scope), mapping.from),
                  owner: binding.owner,
                  file,
                  order: index,
                  category: "helpers",
                });
            continue;
          }
          if (!selector || typeof selector.scope !== "string") continue;
          if (operation.category === "fields" && selector.kind === "record") {
            role = "field";
            fromScope = join(selector.scope, mapping.from);
          } else if (operation.category === "locals-parameters") {
            if (selector.kind === "variable") {
              role = "variable";
              fromScope = qualified(selector.scope);
            } else if (selector.kind === "function") {
              role = "variable";
              owner = {
                scope: selector.scope,
                signature: selector.signature,
                definition: selector.definition,
              };
            }
          } else if (["functions-types", "helpers"].includes(operation.category)) {
            role = selector.kind === "record" ? "type" : selector.kind;
            if (!["function", "type", "variable"].includes(role)) continue;
            fromScope = qualified(selector.scope);
            if (role === "function" && !owner && selector.signature)
              owner = {
                scope: selector.scope,
                signature: selector.signature,
                definition: selector.definition,
              };
          }
          if (!role || (fromScope && leaf(fromScope) !== mapping.from)) continue;
          const item = {
            ...mapping,
            role,
            fromScope,
            parent: fromScope ? parent(fromScope) : undefined,
            owner,
            file,
            order: index,
            category: operation.category,
          };
          names.push(item);
          if (["function", "type"].includes(role) && fromScope)
            nominal.push({ ...item, kind: role });
        }
      }
    }
  return { names, nominal };
}

function projector(nodes, bindings) {
  const { names, nominal } = requirements(nodes, bindings);
  const aliases = nominal
    .filter((rule) => rule.kind === "type")
    .map((rule) => ({ from: rule.fromScope, to: join(parent(rule.fromScope), rule.to) }));
  const signature = (value, scope) => canonicalRepairSignature(value, { scope, bindings, aliases });
  const rulesByName = new Map(),
    namesByName = new Map(),
    scopeMemo = new Map();
  for (const rule of nominal) {
    const key = `${rule.fromScope.split("::").length}:${rule.from}`;
    if (!rulesByName.has(key)) rulesByName.set(key, []);
    rulesByName.get(key).push(rule);
  }
  for (const item of names) {
    if (!namesByName.has(item.from)) namesByName.set(item.from, []);
    namesByName.get(item.from).push(item);
  }
  function scope(value, context = {}, role = "scope") {
    value = qualified(value);
    if (!value) return "";
    const key = JSON.stringify([value, role, context.file, context.owner]);
    if (scopeMemo.has(key)) return scopeMemo.get(key);
    // Rule parents are shorter qualified paths. Marking a visit also rejects
    // malformed owner cycles instead of choosing an arbitrary identity.
    scopeMemo.set(key, undefined);
    const rawParent = parent(value);
    const prefix = scope(rawParent, context);
    if (prefix === undefined) return undefined;
    let current = leaf(value),
      last = -1;
    const seen = new Set([current]);
    for (;;) {
      let matches = (rulesByName.get(`${value.split("::").length}:${current}`) ?? []).filter(
        (rule) => {
          if (rule.order < last || (rule.file && rule.file !== context.file)) return false;
          if (role !== "scope" && role !== rule.kind) return false;
          if (rule.owner?.signature) {
            const actual = signature(context.owner?.signature, context.owner?.scope);
            if (!actual || actual !== signature(rule.owner.signature, rule.owner.scope))
              return false;
          }
          if (
            rule.owner?.scope &&
            !(rule.kind === "function" && qualified(rule.owner.scope) === rule.fromScope)
          ) {
            if (
              !context.owner ||
              scope(context.owner.scope, context, "function") !==
                scope(
                  rule.owner.scope,
                  { file: rule.file ?? context.file, owner: rule.owner },
                  "function",
                )
            )
              return false;
            if (
              typeof rule.owner.definition === "boolean" &&
              rule.owner.definition !== context.owner.definition
            )
              return false;
          }
          return (
            scope(parent(rule.fromScope), {
              file: rule.file ?? context.file,
              owner: rule.owner ?? context.owner,
            }) === prefix
          );
        },
      );
      if (role === "scope" && qualified(context.owner?.scope) === value)
        matches = matches.filter((rule) => rule.kind === "function");
      if (!matches.length) break;
      const targets = new Set(matches.map((rule) => rule.to));
      if (targets.size !== 1) return undefined;
      const next = [...targets][0];
      if (next === current) break;
      if (seen.has(next)) return undefined;
      seen.add(next);
      current = next;
      last = Math.min(...matches.map((rule) => rule.order));
    }
    const result = join(prefix, current);
    scopeMemo.set(key, result);
    return result;
  }
  const localScopesMemo = new Map();
  function localParent(value, binding) {
    if (!value || !binding.owner) return undefined;
    const anchor = scope(binding.owner.scope, ownContext(binding), "function");
    if (!anchor || !(value === anchor || value.startsWith(anchor + "::"))) return undefined;
    if (value === anchor) return anchor;
    const key = JSON.stringify([binding.file, anchor]);
    const normalize = (value, declared) => {
      let prefix = anchor;
      const parts = [];
      for (const part of value.slice(anchor.length + 2).split("::")) {
        prefix = join(prefix, part);
        if (declared.has(prefix)) parts.push(part);
      }
      return join(anchor, parts.join("::"));
    };
    let declared = localScopesMemo.get(key);
    if (!declared) {
      const physical = new Set();
      for (const candidate of bindings) {
        if (candidate.file !== binding.file || !["function", "type"].includes(candidate.role))
          continue;
        const identity = scope(candidate.scope, ownContext(candidate), candidate.role);
        if (identity?.startsWith(anchor + "::")) physical.add(identity);
      }
      // Scope components without named compiler declarations are presentation
      // details of implicit callables, not public local-record/method owners.
      declared = new Set([
        ...physical,
        ...[...physical].map((value) => normalize(value, physical)),
      ]);
      localScopesMemo.set(key, declared);
    }
    return normalize(value, declared);
  }
  function applies(item, binding) {
    if (item.file && item.file !== binding.file) return false;
    if (item.helper) {
      if (!["variable", "function"].includes(binding.role)) return false;
      return !binding.owner || binding.owner.scope === binding.scope;
    }
    if (item.role !== binding.role) return false;
    const context = ownContext(binding);
    if (item.parent !== undefined) {
      const wantedParent = scope(item.parent, {
        file: item.file ?? binding.file,
        owner: item.owner,
      });
      const currentParent = scope(parent(binding.scope), context);
      if (wantedParent !== currentParent) {
        if (item.category !== "locals-parameters" || !item.owner || !binding.owner) return false;
        const wantedLocal = localParent(wantedParent, binding);
        if (wantedLocal === undefined || wantedLocal !== localParent(currentParent, binding))
          return false;
      }
    }
    if (item.owner) {
      if (!binding.owner) return false;
      if (
        scope(
          item.owner.scope,
          { file: item.file ?? binding.file, owner: item.owner },
          "function",
        ) !== scope(binding.owner.scope, context, "function")
      )
        return false;
      const wanted = signature(item.owner.signature, item.owner.scope);
      if (!wanted || wanted !== signature(binding.owner.signature, binding.owner.scope))
        return false;
      if (
        typeof item.owner.definition === "boolean" &&
        item.owner.definition !== binding.owner.definition
      )
        return false;
    }
    return true;
  }
  function project(binding) {
    const context = ownContext(binding);
    const prefix = scope(parent(binding.scope), context);
    if (prefix === undefined) return undefined;
    let wanted = binding.name,
      category;
    if (["function", "type"].includes(binding.role)) {
      const result = scope(binding.scope, context, binding.role);
      if (!result) return undefined;
      wanted = leaf(result);
      category =
        (namesByName.get(binding.name) ?? []).find(
          (item) => item.category === "helpers" && applies(item, binding),
        )?.category ?? "functions-types";
    } else {
      const seen = new Set([wanted]);
      let last = -1;
      for (;;) {
        const matching = (namesByName.get(wanted) ?? []).filter(
          (item) => item.order >= last && applies(item, binding),
        );
        if (!matching.length) break;
        const targets = new Set(matching.map((item) => item.to));
        if (targets.size !== 1) return undefined;
        const next = [...targets][0];
        category = matching.some((item) => item.category === "helpers")
          ? "helpers"
          : matching[0].category;
        if (next === wanted) break;
        if (seen.has(next)) return undefined;
        seen.add(next);
        wanted = next;
        last = Math.min(...matching.map((item) => item.order));
      }
    }
    return {
      name: wanted,
      scope: join(prefix, wanted),
      category,
      signature: signature(
        binding.owner?.signature ?? binding.signature,
        binding.owner?.scope ?? binding.scope,
      ),
    };
  }
  return { project, signature };
}

function setup(operation, target) {
  const result = {};
  if (Array.isArray(operation.includes))
    result.includes = operation.includes
      .filter((item) => item && typeof item.quoted === "boolean" && relative(item.file))
      .map(({ file, quoted }) => ({ file, quoted }));
  if (typeof operation.preamble === "string") result.preamble = operation.preamble;
  if (target.context?.length)
    result.context = target.context.filter(
      (line) =>
        typeof line === "string" &&
        /^using\s+(?:namespace\s+)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\s*;$/.test(line.trim()),
    );
  return result;
}

/** Project already-public requirements onto current compiler declarations.
 * This diagnoses present names and physical ownership; it neither replays old
 * requests nor reads expected source, verifier hashes or preparation masks.
 */
export function diagnoseRepairRequirements({ nodes = [], bindings = [], tree = {} }) {
  const projection = projector(nodes, bindings);
  const sources = new Map(),
    operations = [],
    emitted = new Set();
  const getSource = (file) => {
    if (!relative(file) || typeof tree[file] !== "string") return undefined;
    if (!sources.has(file))
      sources.set(file, {
        text: tree[file],
        position: byteToCharacter(tree[file]),
        tokens: cppTokens(tree[file]).filter((token) => identifier(token.text)),
      });
    return sources.get(file);
  };
  const target = (binding, locate = false) => {
    const source = getSource(binding.file);
    if (!source) return undefined;
    let index = -1,
      start;
    if (locate) {
      try {
        start = source.position(binding.offset);
      } catch {
        return undefined;
      }
      index = source.tokens.findIndex(
        (token) => token.start === start && token.text === binding.name,
      );
      if (index < 0) return undefined;
    }
    const translationUnit =
      relative(binding.translationUnit) && typeof tree[binding.translationUnit] === "string"
        ? binding.translationUnit
        : binding.file.endsWith(".cpp")
          ? binding.file
          : undefined;
    if (locate && !translationUnit) return undefined;
    const result = {
      file: binding.file,
      ...(locate ? { identifier: index } : {}),
      name: binding.name,
      role: binding.role,
      ...(translationUnit ? { translationUnit } : {}),
    };
    for (const field of ["line", "column"])
      if (Number.isSafeInteger(binding[field]) && binding[field] > 0)
        result[field] = binding[field];
    if (typeof binding.scope === "string" && !/\bat\s+[^()]+:\d+:\d+/.test(binding.scope))
      result.scope = binding.scope;
    if (
      binding.owner?.scope &&
      binding.owner.signature &&
      !/\bat\s+[^()]+:\d+:\d+/.test(binding.owner.signature)
    )
      result.owner = {
        scope: binding.owner.scope,
        signature: binding.owner.signature,
        definition: binding.owner.definition,
      };
    return result;
  };
  const add = (operation) => {
    const key = JSON.stringify(operation);
    if (!emitted.has(key)) {
      emitted.add(key);
      operations.push(operation);
    }
  };
  const current = [];
  for (const binding of bindings) {
    if (
      !["variable", "field", "function", "type"].includes(binding.role) ||
      typeof binding.scope !== "string" ||
      !getSource(binding.file)
    )
      continue;
    const projected = projection.project(binding);
    if (!projected) continue;
    current.push({ binding, projected });
    if (projected.name === binding.name || !identifier(binding.name) || !identifier(projected.name))
      continue;
    const selected = target(binding, true);
    if (!selected) continue;
    add({
      phase: "repair",
      action: "rename-binding",
      target: selected,
      required: { name: projected.name },
      category: projected.category ?? (binding.role === "field" ? "fields" : "locals-parameters"),
      files: [
        ...new Set(
          [binding.file, ...(binding.files ?? [])].filter(
            (file) => relative(file) && typeof tree[file] === "string",
          ),
        ),
      ].sort(),
    });
  }
  const goals = [];
  for (const node of nodes)
    for (const operation of node.operations ?? []) {
      if (operation.phase !== "structure") continue;
      const removing = operation.action === "remove-generated-declaration";
      if (operation.action !== "implementation" && !removing) continue;
      const file = operation.file ?? (removing ? "main.cpp" : undefined);
      if (!relative(file)) continue;
      const selected = removing ? [{ selector: operation.selector }] : (operation.targets ?? []);
      for (const item of selected) {
        const selector = item.selector;
        if (!selector?.name || !selector.scope) continue;
        const role = selector.kind === "record" ? "type" : selector.kind;
        if (!["function", "variable", "type"].includes(role)) continue;
        const scope = join(selector.scope, selector.name);
        const pseudo = {
          file,
          name: selector.name,
          role,
          scope,
          declaringScope: qualified(selector.scope),
          definition: !removing,
          ...(role === "function"
            ? { owner: { scope, signature: selector.signature, definition: !removing } }
            : {}),
        };
        const goal = projection.project(pseudo);
        if (!goal || (role === "function" && !goal.signature)) continue;
        goals.push({ removing, role, file, goal, selector, setup: setup(operation, item) });
      }
    }
  const owners = new Map();
  for (const entry of current) {
    if (entry.binding.role === "variable" && entry.binding.owner) continue;
    const key = `${entry.binding.role}:${entry.projected.scope}`;
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push(entry);
  }
  for (const requirement of goals) {
    const matching = (owners.get(`${requirement.role}:${requirement.goal.scope}`) ?? []).filter(
      ({ binding, projected }) =>
        (requirement.role !== "function" || projected.signature === requirement.goal.signature) &&
        (requirement.removing
          ? binding.file === requirement.file && binding.definition === false
          : binding.definition === true),
    );
    const destinations = new Set(
      goals
        .filter(
          (other) =>
            !other.removing &&
            other.role === requirement.role &&
            other.goal.scope === requirement.goal.scope &&
            other.goal.signature === requirement.goal.signature,
        )
        .map((other) => other.file),
    );
    if (!requirement.removing && destinations.size !== 1) continue;
    const sorted = [...matching].sort(
      (a, b) => a.binding.file.localeCompare(b.binding.file) || a.binding.offset - b.binding.offset,
    );
    const selected =
      requirement.removing && requirement.selector.occurrence !== undefined
        ? [sorted[requirement.selector.occurrence]].filter(Boolean)
        : sorted;
    for (const { binding } of selected) {
      if (!requirement.removing && binding.file === requirement.file) continue;
      const selectedTarget = target(binding);
      if (!selectedTarget) continue;
      const required = {
        file: requirement.file,
        qualifiedName: requirement.goal.scope,
        name: requirement.goal.name,
        scope: parent(requirement.goal.scope) || "::",
        ...(requirement.role === "function" ? { signature: requirement.goal.signature } : {}),
        kind: requirement.selector.kind,
        definition: !requirement.removing,
      };
      add({
        phase: "repair",
        action: requirement.removing ? "remove-declaration" : "move-declaration",
        target: selectedTarget,
        required,
        ...(!requirement.removing ? { setup: requirement.setup } : {}),
        files: [...new Set([binding.file, requirement.file])].sort(),
      });
    }
  }
  return operations;
}
