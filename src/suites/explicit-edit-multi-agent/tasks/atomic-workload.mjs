import { createHash } from "node:crypto";
import { coherentTaskPrompt } from "./coherent-tasks.mjs";

const identifier = /^[A-Za-z_]\w*$/;
const words = (value) => new Set(JSON.stringify(value).match(/[A-Za-z_]\w*/g) ?? []);
const physicalKey = (selector) =>
  JSON.stringify([selector.scope ?? "::", selector.declarator, selector.occurrence ?? null]);

function certifiedGroups(operation) {
  const groups = operation.bindingGroups;
  const certification = operation.bindingCertification;
  if (
    !Array.isArray(groups) ||
    !groups.length ||
    certification?.version !== "renderer-atomic-bindings-v1" ||
    certification.sha256 !== createHash("sha256").update(JSON.stringify(groups)).digest("hex")
  )
    throw Error("Missing or incomplete compiler-certified atomic binding groups");
  const seen = new Map();
  const covered = new Set();
  for (const [index, group] of groups.entries()) {
    const mapping = operation.mapping.find(
      (item) => item.from === group?.mapping?.from && item.to === group?.mapping?.to,
    );
    if (
      !mapping ||
      Object.keys(group).some((key) => !["mapping", "selectors", "bindingCount"].includes(key)) ||
      Object.keys(group.mapping).some((key) => !["from", "to"].includes(key)) ||
      !Array.isArray(group.selectors) ||
      !group.selectors.length ||
      !Number.isSafeInteger(group.bindingCount) ||
      group.bindingCount < 1 ||
      group.bindingCount > group.selectors.length ||
      (group.bindingCount > 1 && group.selectors.some((selector) => selector.kind !== "function"))
    )
      throw Error("Atomic binding certification does not cover the original mappings");
    covered.add(mapping.from);
    for (const selector of group.selectors) {
      if (
        !["function", "variable", "type", "record"].includes(selector.kind) ||
        typeof selector.scope !== "string" ||
        !selector.scope ||
        (selector.kind === "function" && !selector.owner?.signature) ||
        (selector.definition !== undefined && typeof selector.definition !== "boolean") ||
        Object.keys(selector).some(
          (key) => !["kind", "scope", "owner", "signature", "definition"].includes(key),
        ) ||
        (selector.owner &&
          (typeof selector.owner.scope !== "string" ||
            typeof selector.owner.signature !== "string" ||
            Object.keys(selector.owner).some(
              (key) => !["scope", "signature", "definition"].includes(key),
            )))
      )
        throw Error("Atomic binding certification contains an invalid public selector");
      const semanticDefinition = ["function", "type"].includes(selector.kind)
        ? null
        : (selector.owner?.definition ?? null);
      const key = JSON.stringify([
        mapping.from,
        mapping.to,
        selector.kind,
        selector.scope,
        selector.signature ?? null,
        selector.definition ?? null,
        selector.owner
          ? [selector.owner.scope, selector.owner.signature, semanticDefinition]
          : null,
      ]);
      if (seen.has(key) && seen.get(key) !== index)
        throw Error("Overlapping atomic binding certification selectors");
      seen.set(key, index);
    }
  }
  if (covered.size !== operation.mapping.length)
    throw Error("Atomic binding certification does not cover the original mappings");
  return groups;
}

function goal(operations, bindingCount = 1) {
  const operation = operations[0];
  if (operation.phase === "names") {
    const [{ from, to }] = operation.mapping;
    if (bindingCount > 1)
      return `Rename the ${bindingCount} selected compiler-certified inseparable overload bindings from ${from} to ${to} together. Update their declarations and shared bound uses, and preserve all other bindings.`;
    return `Rename the selected binding from ${from} to ${to}. Update its declarations and bound uses, and preserve all other bindings.`;
  }
  if (operation.action === "header")
    return `Extract the complete guarded header ${operation.guard} from main.cpp into ${operation.file}, and replace its embedded body with the corresponding include.`;
  if (operation.action === "implementation")
    return `Move only the selected definition or inseparable dependency group from main.cpp into ${operation.file}. Preserve its body and required context. Remove only the temporary declarations listed in this delivery after moving their definitions.`;
  if (operation.action === "vendor-header")
    return `Extract the image-resize header into ${operation.file}. Keep guarded declarations copy ${operation.declarationsCopy} and macro-controlled implementation copy ${operation.implementationCopy}; remove the redundant copies and preserve the selected bodies and conditional branches.`;
  if (operation.action === "vendor-implementation")
    return `Move the listed image-resize implementation activation and its paired include from main.cpp into ${operation.file}.`;
  if (operation.action === "remove-generated-declaration")
    return `Remove only the listed temporary generated declaration from ${operation.file ?? "main.cpp"}. Preserve original declarations and all definition bodies.`;
  if (operation.action === "cleanup-empty-namespaces")
    return "Remove the listed empty namespaces and moved include scaffolding from main.cpp. Preserve its required includes, entry point and remaining code.";
  throw Error(`Unsupported atomic structural action: ${operation.action}`);
}

function validateGraph(nodes) {
  const remaining = new Map(nodes.map((node) => [node.id, node.dependencies.length]));
  const successors = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) for (const id of node.dependencies) successors.get(id).push(node.id);
  const ready = nodes.filter((node) => !node.dependencies.length).map((node) => node.id);
  for (let cursor = 0; cursor < ready.length; cursor++) {
    for (const id of successors.get(ready[cursor])) {
      const count = remaining.get(id) - 1;
      remaining.set(id, count);
      if (!count) ready.push(id);
    }
  }
  if (ready.length !== nodes.length)
    throw Error(
      "Atomic edits require an indivisible rename or selector cycle; preparation must resolve it before execution",
    );
}

// In a complete simple function type, names denote types, not function bindings.
// Deliberately whitelist only qualified return types and empty/void parameters;
// templates, decltype, arrays and unfamiliar syntax keep conservative read edges.
const simpleReturnSignature =
  /^(?:(?:const|volatile)\s+)*(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\s+(?:const|volatile))*(?:\s*[*&]\s*(?:(?:const|volatile)\s*)?)*\s*\(\s*(?:void\s*)?\)$/;

function signatureReads(reader, spelling, functionBinding = false) {
  return reader.operations[0].selectors.some((selector) =>
    [selector.signature, selector.owner?.signature].some(
      (signature) =>
        typeof signature === "string" &&
        words(signature).has(spelling) &&
        !(functionBinding && simpleReturnSignature.test(signature)),
    ),
  );
}

function unrelatedLocalBindings(writer, reader) {
  const selected = writer.operations[0].selectors;
  const consumers = reader.operations[0].selectors;
  return (
    selected?.length &&
    consumers?.length &&
    selected.every((selector) => ["type", "variable"].includes(selector.kind) && selector.owner) &&
    // Owned bindings can escape through extern linkage or inferred return types.
    // Different owners never justify discarding a signature read.
    !signatureReads(reader, writer.operations[0].mapping[0].from) &&
    consumers.every((consumer) =>
      selected.every((selector) => {
        if (
          consumer.owner &&
          (selector.owner.scope !== consumer.owner.scope ||
            selector.owner.signature !== consumer.owner.signature ||
            // Prototype parameters and definition parameters are distinct bindings.
            (selector.kind === "variable" &&
              consumer.kind === "variable" &&
              selector.scope === consumer.scope &&
              typeof selector.owner.definition === "boolean" &&
              typeof consumer.owner.definition === "boolean" &&
              selector.owner.definition !== consumer.owner.definition))
        )
          return true;
        // A local variable cannot rename an unrelated qualified selector. Local
        // types may still alter another selector within their own function.
        return (
          selector.kind === "variable" &&
          ![consumer.scope, consumer.owner?.scope].some(
            (scope) => scope === selector.scope || scope?.startsWith(`${selector.scope}::`),
          )
        );
      }),
    )
  );
}

function separateCertifiedBindings(writer, reader) {
  if (
    writer === reader ||
    writer.sourceOperations[0] !== reader.sourceOperations[0] ||
    writer.operations[0].mapping[0].from !== reader.operations[0].mapping[0].from
  )
    return false;
  const selected = writer.operations[0].selectors;
  if (
    signatureReads(
      reader,
      writer.operations[0].mapping[0].from,
      selected.every((selector) => selector.kind === "function"),
    )
  )
    return false;
  // Disjoint writes do not prove that owner or signature selectors stay valid.
  return !selected.some((selector) =>
    reader.operations[0].selectors.some(
      (consumer) =>
        consumer.scope.startsWith(`${selector.scope}::`) ||
        (consumer.scope !== selector.scope && consumer.owner?.scope === selector.scope),
    ),
  );
}
function compileNaming(task, add, depend) {
  const writers = new Map();
  const local = [];
  for (const [operationIndex, operation] of task.operations.entries()) {
    if (!Array.isArray(operation.mapping) || !operation.mapping.length)
      throw Error("Atomic naming operation has no mappings");
    const mappingNodes = new Map();
    for (const mapping of operation.mapping) {
      if (
        !identifier.test(mapping.from) ||
        !identifier.test(mapping.to) ||
        mapping.from === mapping.to
      )
        throw Error("Invalid atomic binding rename");
      if (mappingNodes.has(mapping.from)) throw Error("Repeated atomic source binding");
      mappingNodes.set(mapping.from, []);
    }
    const groups = certifiedGroups(operation);
    const { bindingGroups: _groups, bindingCertification: _certification, ...original } = operation;
    for (const [bindingGroup, group] of groups.entries()) {
      const current = { ...original, mapping: [{ ...group.mapping }], selectors: group.selectors };
      const node = add([current], [operationIndex], group.bindingCount);
      node.bindingGroup = bindingGroup;
      mappingNodes.get(group.mapping.from).push(node);
      local.push(node);
      if (!writers.has(group.mapping.from)) writers.set(group.mapping.from, []);
      writers.get(group.mapping.from).push(node);
    }
    // A simultaneous batch can free an occupied destination. Its split stream
    // must finish that rename first; swaps cannot be silently sequentialized.
    for (const mapping of operation.mapping) {
      const occupying = mappingNodes.get(mapping.to);
      if (occupying)
        for (const node of mappingNodes.get(mapping.from))
          for (const prerequisite of occupying) depend(node, prerequisite);
    }
  }
  // A scope/signature selector is an input to the edit. Read its old spelling
  // before changing that spelling. This avoids stale selectors without replacing
  // unrelated same-spelling owners or guessing C++ bindings from bare text.
  for (const reader of local) {
    for (const spelling of words(reader.operations[0].selectors ?? []))
      for (const writer of writers.get(spelling) ?? [])
        if (!separateCertifiedBindings(writer, reader) && !unrelatedLocalBindings(writer, reader))
          depend(writer, reader);
  }
}

function compileStructure(task, add, depend) {
  const entries = task.operations.map((operation, index) => ({ operation, index }));
  const moves = entries.filter(({ operation }) => operation.action === "implementation");
  const ownedCleanup = new Map(moves.map((entry) => [entry.index, []]));
  const assigned = new Set();
  for (const entry of entries.filter(
    ({ operation }) => operation.action === "remove-generated-declaration",
  )) {
    const owners = moves.filter(
      ({ operation }) =>
        operation.file === entry.operation.file &&
        operation.targets.some(
          (target) => physicalKey(target.selector) === physicalKey(entry.operation.selector),
        ),
    );
    if (owners.length > 1) throw Error("Ambiguous atomic temporary declaration owner");
    if (owners.length === 1) {
      ownedCleanup.get(owners[0].index).push(entry);
      assigned.add(entry.index);
    }
  }
  const byIndex = new Map();
  for (const entry of entries) {
    if (assigned.has(entry.index)) continue;
    const cleanup = ownedCleanup.get(entry.index) ?? [];
    const operations = [entry.operation, ...cleanup.map((item) => item.operation)];
    const node = add(operations, [entry.index, ...cleanup.map((item) => item.index)]);
    byIndex.set(entry.index, node);
    for (const item of cleanup) byIndex.set(item.index, node);
  }
  const anchors = new Map();
  for (const entry of moves) {
    const node = byIndex.get(entry.index);
    for (const target of entry.operation.targets) {
      const key = JSON.stringify([entry.operation.file, physicalKey(target.selector)]);
      if (anchors.has(key)) throw Error("Repeated atomic implementation target");
      anchors.set(key, node);
    }
  }
  for (const entry of entries) {
    const node = byIndex.get(entry.index),
      operation = entry.operation;
    if (operation.action === "implementation") {
      for (const target of operation.targets)
        for (const anchor of [target.before, target.after].filter(Boolean)) {
          const producer = anchors.get(JSON.stringify([operation.file, physicalKey(anchor)]));
          if (producer) depend(node, producer);
        }
    } else if (operation.action === "vendor-implementation") {
      const headers = entries.filter(
        (candidate) =>
          candidate.operation.action === "vendor-header" &&
          candidate.operation.macro === operation.macro,
      );
      if (headers.length !== 1)
        throw Error("Missing or ambiguous atomic vendor header prerequisite");
      depend(node, byIndex.get(headers[0].index));
    } else if (operation.action === "remove-generated-declaration" && !assigned.has(entry.index)) {
      // A declaration inside a conditional move need not have a top-level owner
      // selector. Do not guess which conditional branch supplied it.
      for (const move of moves.filter((candidate) => candidate.operation.file === operation.file))
        depend(node, byIndex.get(move.index));
    } else if (operation.action === "cleanup-empty-namespaces") {
      for (const previous of entries.filter(
        (candidate) => candidate.operation.action !== "cleanup-empty-namespaces",
      ))
        depend(node, byIndex.get(previous.index));
    }
  }
}

/** Split coarse restoration groups into one current public edit per delivery.
 * IDs and graph edges are stable for the same ordered input. Each node retains
 * its scoring taskId; sourceOperations identifies the original operation indexes
 * for private coverage auditing, not instructions or saved replacement source.
 * Naming operations require compiler-certified bindingGroups from atomicPlans().
 * A naming node's bindingGroup index plus sourceOperations[0] locates its private
 * plan in preparation; plans never enter the delivered operation or prompt.
 * The certificate checksum detects changed groups, not untrusted provenance:
 * callers must seal the originating source and compiler evidence separately.
 * renameMappings counts original requirements; namingBindings counts semantic
 * bindings, namingEdits counts their deliveries and coupledNamingEdits counts
 * certified inseparable overload deliveries. Every naming group requires its
 * compiler-sealed bindingCount; multiple bindings remain one logical delivery.
 * Dependencies are sparse and local to a scoring group. The caller retains the
 * existing group/barrier graph and must pass structural gates before unlocking
 * successors. Cyclic sequential renames fail closed instead of changing meaning.
 */
export function atomicWorkload(tasks) {
  if (
    !Array.isArray(tasks) ||
    !tasks.length ||
    new Set(tasks.map((task) => task.id)).size !== tasks.length
  )
    throw Error("Invalid atomic workload groups");
  const nodes = [],
    edges = new Map();
  for (const task of tasks) {
    if (
      typeof task.id !== "string" ||
      !task.id ||
      !Array.isArray(task.operations) ||
      !task.operations.length
    )
      throw Error("Invalid atomic workload group");
    const operations = structuredClone(task.operations);
    let ordinal = 0;
    const add = (current, sourceOperations, bindingCount) => {
      const node = {
        id: `${task.id}-edit-${String(++ordinal).padStart(5, "0")}`,
        taskId: task.id,
        operations: current,
        prompt: coherentTaskPrompt(goal(current, bindingCount), current),
        ...(bindingCount === undefined ? {} : { bindingCount }),
        dependencies: [],
        sourceOperations,
      };
      nodes.push(node);
      edges.set(node.id, new Set());
      return node;
    };
    const depend = (node, prerequisite) => {
      if (node !== prerequisite) edges.get(node.id).add(prerequisite.id);
    };
    const current = { ...task, operations };
    if (task.phase === "names" && operations.every((operation) => operation.phase === "names"))
      compileNaming(current, add, depend);
    else if (
      task.phase === "structure" &&
      operations.every((operation) => operation.phase === "structure")
    )
      compileStructure(current, add, depend);
    else throw Error("Mixed or unsupported atomic workload phase");
  }
  for (const node of nodes) node.dependencies = [...edges.get(node.id)].sort();
  validateGraph(nodes);
  const naming = nodes.filter((node) => node.operations[0].phase === "names");
  return {
    version: "renderer-atomic-workload-v1",
    nodes,
    summary: {
      groups: tasks.length,
      atomicEdits: nodes.length,
      originalOperations: tasks.reduce((sum, task) => sum + task.operations.length, 0),
      renameMappings: tasks.reduce(
        (sum, task) => sum + task.operations.reduce((n, op) => n + (op.mapping?.length ?? 0), 0),
        0,
      ),
      namingBindings: naming.reduce((sum, node) => sum + node.bindingCount, 0),
      namingEdits: naming.length,
      coupledNamingEdits: naming.filter((node) => node.bindingCount > 1).length,
      dependencyEdges: nodes.reduce((sum, node) => sum + node.dependencies.length, 0),
      maximumPromptChars: Math.max(...nodes.map((node) => node.prompt.length)),
    },
  };
}
