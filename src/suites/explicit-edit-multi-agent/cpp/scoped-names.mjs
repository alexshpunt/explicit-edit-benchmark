import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { joinedProject } from "./joined-project.mjs";
import {
  projectAst,
  anonymousRecordAliases,
  declarationContexts,
  writtenFunctionSignatures,
  isFunctionInstantiation,
} from "./compiler-ast.mjs";
import { variableBindingEdits } from "../generation/semantic-names.mjs";
import { semanticSession } from "./clangd-renames.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";
import { createDirectCallEditFilter } from "./direct-call-edits.mjs";
import { createTemplateCallWitness } from "./template-call-witness.mjs";
import { createReferenceCallWitness } from "./reference-call-witness.mjs";
import { coupleAtomicBindings, validateAtomicBindingCoupling } from "./atomic-binding-coupling.mjs";

function matchesPublicSelector(entry, category, selector) {
  const owner = entry.owner;
  if (category === "helpers" && !entry.fileHelper) return false;
  if (
    selector.owner &&
    (owner?.scope !== selector.owner.scope ||
      owner.signature !== selector.owner.signature ||
      (typeof selector.owner.definition === "boolean" &&
        owner.definition !== selector.owner.definition))
  )
    return false;
  if (category === "locals-parameters") {
    if (entry.role !== "variable") return false;
    if (selector.kind === "function")
      return (
        owner?.scope === selector.scope &&
        owner.signature === selector.signature &&
        (typeof selector.definition !== "boolean" || owner.definition === selector.definition)
      );
    return selector.kind === "variable" && entry.scope === selector.scope;
  }
  if (category === "fields")
    return (
      entry.role === "field" &&
      selector.kind === "record" &&
      entry.declaringScope === selector.scope
    );
  return selector.kind === entry.role && entry.scope === selector.scope;
}
function publicNamingSelector(entry, category) {
  if (entry.owner?.signature && /\bat\s+[^()]+:\d+:\d+/.test(entry.owner.signature))
    throw Error("Atomic binding owner has a private compiler-location signature");
  return {
    kind: category === "fields" ? "record" : entry.role,
    scope: category === "fields" ? entry.declaringScope : entry.scope,
    ...(entry.owner ? { owner: { ...entry.owner } } : {}),
  };
}

const declarationSiteKey = (origin) => JSON.stringify([origin.file, origin.start, origin.role]);
const sameSites = (first, second) =>
  first.size === second.size && [...first].every((key) => second.has(key));

function publicBindingCertification(groups) {
  return {
    version: "renderer-atomic-bindings-v1",
    sha256: createHash("sha256").update(JSON.stringify(groups)).digest("hex"),
  };
}

function declarationIndex(roots, source) {
  const aliases = anonymousRecordAliases(roots);
  return {
    bytes: Buffer.from(source),
    aliases,
    contexts: declarationContexts(roots, aliases),
    signatures: writtenFunctionSignatures(roots),
  };
}

function selectedDeclarations(
  roots,
  requests,
  source,
  renamed,
  origin,
  onDeclaration,
  allowAbsentOwners = false,
  index = declarationIndex(roots, source),
) {
  const { bytes, aliases, contexts, signatures } = index;
  const selections = [];
  const isFunction = (node) =>
    ["FunctionDecl", "CXXMethodDecl", "CXXConstructorDecl", "CXXDestructorDecl"].includes(
      node.kind,
    );
  const typeKinds = new Set([
    "CXXRecordDecl",
    "ClassTemplateSpecializationDecl",
    "RecordDecl",
    "EnumDecl",
    "TypedefDecl",
    "TypeAliasDecl",
  ]);
  function visit(node, scope = "", owner) {
    if (isFunctionInstantiation(node, signatures)) return;
    if (node.parentDeclContextId)
      scope = contexts
        .get(node.parentDeclContextId)
        .map((parent) => renamed.get(parent.loc?.offset) ?? parent.name)
        .join("::");
    const namedNode = aliases.get(node.id) ?? node;
    const currentName = renamed.get(namedNode.loc?.offset) ?? namedNode.name;
    const functionOwner =
      owner ??
      (isFunction(node)
        ? {
            scope: [scope, currentName].filter(Boolean).join("::"),
            signature: signatures.get(node.loc?.offset) ?? node.type?.qualType,
            definition: (node.inner ?? []).some((child) => child.kind === "CompoundStmt"),
          }
        : undefined);
    const fullName = [scope, currentName].filter(Boolean).join("::");
    let role;
    if (["VarDecl", "ParmVarDecl"].includes(node.kind)) role = "variable";
    else if (node.kind === "FieldDecl") role = "field";
    else if (typeKinds.has(node.kind)) role = "type";
    else if (["FunctionDecl", "CXXMethodDecl"].includes(node.kind)) role = "function";
    const offset = node.loc?.offset;
    if (
      role &&
      !node.isImplicit &&
      Number.isInteger(offset) &&
      /^[A-Za-z_]\w*$/.test(node.name ?? "") &&
      bytes.subarray(offset, offset + Buffer.byteLength(node.name)).toString("utf8") === node.name
    ) {
      const declaration = {
        offset,
        name: node.name,
        role,
        scope: fullName,
        declaringScope: scope,
        fileHelper:
          (role === "variable" && !functionOwner) || (node.kind === "FunctionDecl" && !owner),
        owner: functionOwner,
        localDefinition:
          functionOwner?.definition === true &&
          (node.kind === "ParmVarDecl" ||
            (node.kind === "VarDecl" && node.storageClass !== "extern")),
      };
      onDeclaration?.(declaration);
      for (const request of requests) {
        const mapping = request.mapping.find((item) => item.from === node.name);
        if (!mapping) continue;
        const matches = request.selectors?.some((selector) =>
          matchesPublicSelector(declaration, request.category, selector),
        );
        const helper =
          request.category === "helpers" &&
          !request.selectors &&
          declaration.fileHelper &&
          origin(offset, Buffer.byteLength(node.name)).file === request.file;
        if (
          (matches &&
            (request.category !== "helpers" ||
              origin(offset, Buffer.byteLength(node.name)).file === request.file)) ||
          helper
        )
          selections.push({
            ...declaration,
            newName: mapping.to,
            family: request.id ?? request.target,
          });
      }
    }
    let nested = scope;
    if (node.kind === "NamespaceDecl" || typeKinds.has(node.kind) || isFunction(node))
      nested = [scope, currentName].filter(Boolean).join("::");
    for (const child of node.inner ?? []) visit(child, nested, functionOwner);
  }
  for (const root of roots) visit(root);
  const physical = new Map();
  for (const selection of selections) {
    const previous = physical.get(selection.offset);
    if (
      previous &&
      (previous.family !== selection.family || previous.newName !== selection.newName)
    )
      throw new Error("Conflicting selected physical bindings");
    physical.set(selection.offset, selection);
  }
  const selected = [...physical.values()];
  for (const request of requests) {
    for (const mapping of request.mapping) {
      if (
        !allowAbsentOwners &&
        !selected.some(
          (entry) => entry.family === (request.id ?? request.target) && entry.name === mapping.from,
        )
      )
        throw new Error(`Missing current owner/signature binding: ${mapping.from}`);
    }
  }
  return selected;
}

/** Refresh public selectors in one AST pass after earlier type renames.
 * Three arguments return selector arrays for the supplied private origin groups.
 * With certifications, groups must contain each request's full declaration origins,
 * followed by its atoms' origins, all rebased into tree by applied union plans.
 * Returns { selectors, certifications }: each refreshed atom must select exactly
 * its original compiler-certified declarations through the runtime matcher.
 * Public groups/checksums are regenerated only after that verification; private
 * plans and declarations stay at their original snapshot offsets for later sealing.
 * No AST IDs, declaration origins or physical plans enter public operations.
 */
export async function currentNamingSelectors(
  tree,
  groups,
  directory,
  certifications,
  applied = [],
) {
  const image = joinedProject(tree);
  const sourcePath = path.join(directory, "current.cpp");
  await writeFile(sourcePath, image.source);
  const roots = await projectAst(sourcePath, ["-std=c++17", "-pthread"]);
  const declarations = new Map();
  const byName = new Map();
  selectedDeclarations(roots, [], image.source, new Map(), image.physical, (entry) => {
    const site = {
      ...image.physical(entry.offset, Buffer.byteLength(entry.name)),
      role: entry.role,
    };
    const key = declarationSiteKey(site);
    const previous = declarations.get(key);
    const { offset: _offset, ...identity } = entry;
    const signature = JSON.stringify(identity);
    if (previous?.identities.has(signature)) return;
    if (previous) previous.identities.add(signature);
    else declarations.set(key, { entry, site, identities: new Set([signature]) });
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push({ entry, site });
  });
  function selectorsFor(origins, category) {
    const selectors = new Map();
    for (const origin of origins) {
      const declaration = declarations.get(declarationSiteKey(origin));
      if (!declaration) throw Error("Missing refreshed current declaration owner");
      if (declaration.identities.size !== 1)
        throw Error(`Ambiguous current declaration owner: ${declarationSiteKey(origin)}`);
      const selector = publicNamingSelector(declaration.entry, category);
      selectors.set(JSON.stringify(selector), selector);
    }
    return [...selectors.values()];
  }
  if (!certifications) return groups.map((origins) => selectorsFor(origins));
  const edits = applied.flatMap((plan) => plan.edits);
  function rebase(origin) {
    return {
      ...origin,
      start:
        origin.start +
        edits
          .filter((edit) => edit.file === origin.file && edit.start < origin.start)
          .reduce((sum, edit) => sum + edit.new.length - edit.old.length, 0),
    };
  }
  const selectors = [];
  const refreshed = [];
  let cursor = 0;
  for (const certification of certifications) {
    const { operation, atoms, plan } = certification;
    const { bindingGroups, bindingCertification, ...original } = operation;
    if (
      !Array.isArray(bindingGroups) ||
      !bindingGroups.length ||
      !Array.isArray(atoms) ||
      atoms.length !== bindingGroups.length ||
      JSON.stringify(bindingCertification) !==
        JSON.stringify(publicBindingCertification(bindingGroups))
    )
      throw Error("Invalid original compiler binding certification");
    const fullOrigins = groups[cursor++];
    if (!fullOrigins?.length) throw Error("Missing certified declaration origins");
    const fullSelectors = selectorsFor(fullOrigins, operation.category);
    selectors.push(fullSelectors);
    const allSites = new Set();
    const allEdits = new Map();
    const newGroups = [];
    const newAtoms = [];
    for (const [index, atom] of atoms.entries()) {
      const group = bindingGroups[index];
      if (
        !Number.isSafeInteger(group?.bindingCount) ||
        group.bindingCount < 1 ||
        group.bindingCount > (group.selectors?.length ?? 0) ||
        (group.bindingCount > 1 &&
          group.selectors.some((selector) => selector.kind !== "function")) ||
        atom.bindingGroup !== index ||
        JSON.stringify(atom.operation) !==
          JSON.stringify({
            ...original,
            mapping: [group.mapping],
            selectors: group.selectors,
          }) ||
        !operation.mapping.some(
          (mapping) => JSON.stringify(mapping) === JSON.stringify(group.mapping),
        ) ||
        atom.plan.id !== plan.id ||
        !atom.plan.edits.length ||
        !atom.declarations?.length
      )
        throw Error("Invalid certified declaration binding");
      validateAtomicBindingCoupling(atom, group.bindingCount);
      for (const edit of atom.plan.edits) {
        const key = JSON.stringify([edit.file, edit.start]);
        if (allEdits.has(key) || edit.old !== group.mapping.from || edit.new !== group.mapping.to)
          throw Error("Overlapping or mismatched certified binding plans");
        allEdits.set(key, edit);
      }
      const expected = new Set();
      for (const origin of atom.declarations) {
        if (
          !atom.plan.edits.some((edit) => edit.file === origin.file && edit.start === origin.start)
        )
          throw Error("Invalid certified declaration origin");
        const key = declarationSiteKey(rebase(origin));
        if (expected.has(key) || allSites.has(key))
          throw Error("Overlapping certified declaration origins");
        expected.add(key);
        allSites.add(key);
      }
      const origins = groups[cursor++];
      if (!origins || !sameSites(expected, new Set(origins.map(declarationSiteKey))))
        throw Error("Refreshed origins differ from certified declarations");
      const publicSelectors = selectorsFor(origins, operation.category);
      const addressed = new Set(
        (byName.get(group.mapping.from) ?? [])
          .filter(
            ({ entry, site }) =>
              publicSelectors.some((selector) =>
                matchesPublicSelector(entry, operation.category, selector),
              ) &&
              (operation.category !== "helpers" || site.file === operation.file),
          )
          .map(({ site }) => declarationSiteKey(site)),
      );
      if (!sameSites(expected, addressed))
        throw Error(
          "Refreshed selector does not select the same declarations of its certified binding",
        );
      selectors.push(publicSelectors);
      newGroups.push({
        mapping: { ...group.mapping },
        selectors: publicSelectors,
        bindingCount: group.bindingCount,
      });
      newAtoms.push({
        ...atom,
        operation: { ...original, mapping: [{ ...group.mapping }], selectors: publicSelectors },
      });
    }
    const union = (items) =>
      JSON.stringify(
        items.map((edit) => JSON.stringify([edit.file, edit.start, edit.old, edit.new])).sort(),
      );
    if (
      !sameSites(allSites, new Set(fullOrigins.map(declarationSiteKey))) ||
      union([...allEdits.values()]) !== union(plan.edits) ||
      operation.mapping.some(
        (mapping) =>
          !newGroups.some((group) => JSON.stringify(group.mapping) === JSON.stringify(mapping)),
      )
    )
      throw Error(
        "Certified declaration origins or binding plans do not cover the original request",
      );
    refreshed.push({
      ...certification,
      operation: {
        ...original,
        selectors: fullSelectors,
        bindingGroups: newGroups,
        bindingCertification: publicBindingCertification(newGroups),
      },
      atoms: newAtoms,
    });
  }
  if (cursor !== groups.length) throw Error("Unexpected certified declaration origin groups");
  return { selectors, certifications: refreshed };
}
/** Open a current compiler snapshot for a single naming batch. Only the next
 * delivered request is selected. No future requests, inverse records or answers enter this session.
 * Close it before grading; the next batch reparses the actual evolving workspace.
 * Optional onSelection receives current declaration origins for trusted module grouping;
 * it does not alter selected bindings or expose saved restoration locations.
 * allowAbsentOwners is for callers merging separate translation units: that caller
 * must reject any mapping missing from the combined plans. Ordinary sessions stay strict.
 * plan(request, { localDefinitionOnly: true }) additionally requires a compiler-
 * proven parameter or non-extern local in this view's physical implementation.
 * This rejects namespace bindings and included-header definitions before edits.
 */
export async function scopedNamingSession(
  tree,
  directory,
  { file, onSelection, allowAbsentOwners = false } = {},
) {
  const image = joinedProject(tree, file ? [file] : undefined);
  const sourcePath = path.join(directory, "current.cpp");
  await writeFile(sourcePath, image.source);
  const flags = ["-std=c++17", "-pthread"];
  const roots = await projectAst(sourcePath, flags);
  // This compiler document is unchanged; only the renamed ledger is dynamic.
  const declarations = declarationIndex(roots, image.source);
  let compiler;
  const inspector = {
    ast: (range) => compiler.ast(range),
    symbols: (position) => compiler.symbols(position),
  };
  const templateWitness = createTemplateCallWitness(roots, image.source, inspector);
  const referenceWitness = createReferenceCallWitness(roots, image.source, inspector);
  let directCalls;
  // Local-variable plans never consult semantic call exclusions. Build this
  // compiler index only when a delivered semantic edit actually needs it.
  const directCallFilter = () =>
    (directCalls ??= createDirectCallEditFilter(roots, image.source, {
      canExclude: async (evidence) =>
        (await templateWitness(evidence)) || referenceWitness(evidence),
    }));
  const keepEdit = (...args) => directCallFilter()(...args);
  const consumed = new Set();
  const renamed = new Map();
  let probed;
  const siteKey = (edit) => JSON.stringify([edit.file, edit.start]);
  const planSignature = (plan) =>
    JSON.stringify(
      plan.edits.map((edit) => JSON.stringify([edit.file, edit.start, edit.old, edit.new])).sort(),
    );

  function select(request, onDeclaration) {
    if (request.category === "helpers" && request.file !== file)
      throw new Error("File-local helper needs its own compiler snapshot");
    return selectedDeclarations(
      roots,
      [request],
      image.source,
      renamed,
      image.physical,
      onDeclaration,
      allowAbsentOwners,
      declarations,
    );
  }
  function notify(selection) {
    onSelection?.(
      selection.map((entry) => ({
        ...image.physical(entry.offset, Buffer.byteLength(entry.name)),
        role: entry.role,
      })),
    );
  }
  async function editsFor(selection) {
    const local = selection.filter((entry) => entry.role === "variable");
    const semantic = selection.filter((entry) => entry.role !== "variable");
    if (semantic.length) compiler ??= await semanticSession(sourcePath, image.source, flags);
    return [
      ...(local.length ? variableBindingEdits(roots, local, image.source) : []),
      ...(semantic.length ? await compiler.edits(semantic, { keepEdit }) : []),
    ];
  }
  function physicalPlan(id, edits) {
    const physical = new Map();
    for (const edit of edits) {
      if (edit.families.length !== 1) throw new Error("Compiler binding crosses requests");
      const byteStart = Buffer.byteLength(image.source.slice(0, edit.start));
      const site = image.physical(byteStart, Buffer.byteLength(edit.old));
      if (tree[site.file].slice(site.start, site.start + edit.old.length) !== edit.old)
        throw new Error("Physical compiler origin differs");
      const key = siteKey(site);
      const previous = physical.get(key);
      if (previous && (previous.old !== edit.old || previous.new !== edit.new))
        throw new Error("Repeated header binding conflict");
      if (consumed.has(key)) throw new Error("Binding already changed by an earlier request");
      physical.set(key, { ...site, old: edit.old, new: edit.new });
    }
    if (!physical.size) throw new Error("Empty current naming request");
    return { id, edits: [...physical.values()] };
  }
  function commit(selection, plan) {
    probed = undefined;
    for (const edit of plan.edits)
      if (consumed.has(siteKey(edit)))
        throw new Error("Binding already changed by an earlier request");
    for (const edit of plan.edits) consumed.add(siteKey(edit));
    for (const entry of selection)
      if (["type", "function"].includes(entry.role)) renamed.set(entry.offset, entry.newName);
  }
  return {
    close: () => compiler?.close(),
    /** Check exact definition-local bindings in this physical implementation.
     * This consumes no rename. An immediate identical plan reuses the selection;
     * any committed request discards the probe. Consumed declarations do not match. */
    hasLocalBinding(request) {
      probed = undefined;
      const selection = selectedDeclarations(
        roots,
        [request],
        image.source,
        renamed,
        image.physical,
        undefined,
        true,
        declarations,
      );
      const found =
        selection.length > 0 &&
        request.mapping.every((mapping) =>
          selection.some((entry) => entry.name === mapping.from),
        ) &&
        selection.every((entry) => {
          const site = image.physical(entry.offset, Buffer.byteLength(entry.name));
          return entry.localDefinition && site.file === file && !consumed.has(siteKey(site));
        });
      if (found) probed = { key: JSON.stringify(request), selection };
      return found;
    },
    async plan(request, { localDefinitionOnly = false } = {}) {
      const selection =
        probed?.key === JSON.stringify(request) ? probed.selection : select(request);
      probed = undefined;
      if (
        localDefinitionOnly &&
        selection.some(
          (entry) =>
            !entry.localDefinition ||
            image.physical(entry.offset, Buffer.byteLength(entry.name)).file !== file,
        )
      )
        throw Error("Unsupported local reference outside the selected implementation definition");
      notify(selection);
      if (allowAbsentOwners && !selection.length) {
        return { id: request.id ?? request.target, edits: [] };
      }
      const plan = physicalPlan(request.id ?? request.target, await editsFor(selection));
      commit(selection, plan);
      return plan;
    },
    /** Certify the next delivered naming request against this unchanged snapshot.
     * Identical semantic edit sets are one binding, including alias-spelled
     * redeclarations. Disjoint sets are separate atoms. Only positive compiler
     * evidence of shared instantiated calls permits a minimal inseparable overload
     * group; unknown overlaps and indistinguishable bindings fail before consumption.
     * Returns { operation, plan, atoms }. operation.bindingGroups and its checksum
     * contain public mappings/selectors and the honest semantic bindingCount.
     * Each atom is indexed by bindingGroup
     * and contains a single-mapping public operation plus its PRIVATE physical plan
     * and declarations: [{ file, start, role }]. Coupled atoms also retain PRIVATE
     * coupling evidence tied to the joined compiler snapshot. These selected
     * sites let currentNamingSelectors verify a later rebased selector refresh.
     * plan is the union equivalent to the original request, so callers do not call
     * plan(request) a second time. Successful certification consumes that union
     * once; failed certification leaves the original request usable. The checksum
     * detects missing/reordered groups; trust comes from maintainer preparation's
     * sealed source/plan evidence, not from a contributor-supplied checksum.
     */
    async atomicPlans(request) {
      if (
        !Array.isArray(request.mapping) ||
        !request.mapping.length ||
        new Set(request.mapping.map((mapping) => mapping.from)).size !== request.mapping.length ||
        request.mapping.some(
          (mapping) =>
            !/^[A-Za-z_]\w*$/.test(mapping.from) ||
            !/^[A-Za-z_]\w*$/.test(mapping.to) ||
            mapping.from === mapping.to,
        )
      )
        throw Error("Invalid atomic binding mappings");
      const declarationsByName = new Map(request.mapping.map((mapping) => [mapping.from, []]));
      const selection = select(request, (entry) => declarationsByName.get(entry.name)?.push(entry));
      if (
        request.mapping.some((mapping) => !selection.some((entry) => entry.name === mapping.from))
      )
        throw Error("Cannot certify absent atomic bindings in one snapshot");
      const id = request.id ?? request.target;
      const cache = new Map();
      const bySignature = new Map();
      const nativePlans = new Map();
      const entryKey = (entry) => JSON.stringify([entry.offset, entry.newName]);
      async function entryPlan(entry) {
        const key = entryKey(entry);
        if (!cache.has(key)) {
          const edits = await editsFor([entry]);
          nativePlans.set(key, edits);
          cache.set(key, physicalPlan(id, edits));
        }
        return cache.get(key);
      }
      for (const entry of selection) {
        const plan = await entryPlan(entry);
        const signature = planSignature(plan);
        let binding = bySignature.get(signature);
        if (!binding) {
          binding = {
            plan,
            signature,
            entries: [],
            mapping: { from: entry.name, to: entry.newName },
            joinedSites: new Map(),
          };
          bySignature.set(signature, binding);
        }
        binding.entries.push(entry);
        for (const edit of nativePlans.get(entryKey(entry))) {
          const origin = image.physical(
            Buffer.byteLength(image.source.slice(0, edit.start)),
            Buffer.byteLength(edit.old),
          );
          const key = siteKey(origin);
          const views = binding.joinedSites.get(key) ?? new Map();
          views.set(edit.start, { start: edit.start, old: edit.old, new: edit.new });
          binding.joinedSites.set(key, views);
        }
      }
      const origin = (entry) => ({
        ...image.physical(entry.offset, Buffer.byteLength(entry.name)),
        role: entry.role,
      });
      const sourceSha256 = createHash("sha256").update(image.source).digest("hex");
      const probes = new Map();
      const proofKey = ({ required, allowed, edit }) => JSON.stringify({ required, allowed, edit });
      let coupled;
      for (;;) {
        const unresolved = [];
        try {
          coupled = coupleAtomicBindings([...bySignature.values()], {
            sharedCall: (evidence) => {
              if (directCallFilter().sharedCall(evidence)) return true;
              const key = proofKey(evidence);
              if (probes.has(key)) return probes.get(key)?.sharedCall(evidence) === true;
              unresolved.push(evidence);
              return false;
            },
            origin,
            sourceSha256,
          });
          break;
        } catch (error) {
          const missing = unresolved.at(-1);
          if (
            error.diagnostic?.reason !== "Shared call lacks positive compiler binding evidence" ||
            !missing ||
            probes.has(proofKey(missing))
          )
            throw error;
          // Controller-only certification may force a private instantiation of an
          // otherwise uninstantiated original template. The live .plan() path
          // never loads this module or receives its source/proof artifacts.
          const { proveSharedCallInstantiation } = await import("./shared-call-instantiation.mjs");
          const proof = await proveSharedCallInstantiation({
            roots,
            source: image.source,
            ...missing,
            directory,
            sourcePath,
          });
          if (!proof) throw error;
          const overlay = await readFile(proof.evidence.overlayFile, "utf8");
          const expectedOverlay = JSON.stringify({
            version: 0,
            "use-external-names": false,
            roots: [
              { type: "file", name: sourcePath, "external-contents": proof.evidence.probeFile },
            ],
          });
          if (
            proof.evidence.logicalFile !== sourcePath ||
            overlay !== expectedOverlay ||
            createHash("sha256").update(overlay).digest("hex") !== proof.evidence.overlaySha256
          )
            throw Error("Private instantiation overlay differs from the original logical file", {
              cause: error,
            });
          if (
            proof.evidence.sourceSha256 !== sourceSha256 ||
            createHash("sha256")
              .update(image.source + proof.evidence.suffix)
              .digest("hex") !== proof.evidence.probeSha256 ||
            proof.evidence.calleeOffset !==
              Buffer.byteLength(image.source.slice(0, missing.edit.start)) ||
            !proof.sharedCall(missing)
          )
            throw Error("Private instantiation proof differs from its original compiler view", {
              cause: error,
            });
          probes.set(proofKey(missing), {
            ...proof,
            input: missing,
            evidence: { ...proof.evidence, callStart: missing.edit.start },
          });
        }
      }
      for (const binding of coupled) {
        if (!binding.coupling) continue;
        const instantiations = [];
        for (const proof of probes.values()) {
          if (!proof) continue;
          const site = image.physical(
            Buffer.byteLength(image.source.slice(0, proof.evidence.callStart)),
            Buffer.byteLength(binding.mapping.from),
          );
          if (
            binding.coupling.sites.some(
              (shared) => shared.file === site.file && shared.start === site.start,
            )
          )
            instantiations.push({
              site,
              proof: proof.evidence,
              declarations: [
                ...new Map(
                  proof.input.required.map((entry) => {
                    const declaration = origin(entry);
                    return [siteKey(declaration), declaration];
                  }),
                ).values(),
              ],
            });
        }
        if (instantiations.length) binding.coupling.instantiations = instantiations;
      }
      const bindings = coupled.sort(
        (a, b) =>
          request.mapping.findIndex((mapping) => mapping.from === a.mapping.from) -
          request.mapping.findIndex((mapping) => mapping.from === b.mapping.from),
      );
      const {
        bindingGroups: _oldGroups,
        bindingCertification: _oldCertification,
        prompt: _legacyPrompt,
        dependsOn: _legacyDependencies,
        ...original
      } = request;
      const atoms = [];
      const bindingGroups = [];
      for (const binding of bindings) {
        const publicSelectors = new Map(
          binding.entries.map((entry) => {
            const selector = publicNamingSelector(entry, request.category);
            return [JSON.stringify(selector), selector];
          }),
        );
        const operation = {
          ...original,
          mapping: [{ ...binding.mapping }],
          selectors: [...publicSelectors.values()],
        };
        // Index the same AST declarations once per coarse request. Checking each
        // atom uses the runtime matcher, without reparsing or walking the whole
        // project again for every binding.
        const addressed = declarationsByName
          .get(binding.mapping.from)
          .filter(
            (entry) =>
              operation.selectors.some((selector) =>
                matchesPublicSelector(entry, request.category, selector),
              ) &&
              (request.category !== "helpers" ||
                image.physical(entry.offset, Buffer.byteLength(entry.name)).file === request.file),
          )
          .map((entry) => ({ ...entry, newName: binding.mapping.to, family: id }));
        if (!addressed.length) throw Error("Public selector cannot address one atomic binding");
        const addressedPlans = new Set();
        for (const entry of addressed) {
          const signature = planSignature(await entryPlan(entry));
          if (!binding.memberSignatures.has(signature))
            throw Error("Public selector identifies indistinguishable independent bindings");
          addressedPlans.add(signature);
        }
        if (addressedPlans.size !== binding.memberSignatures.size)
          throw Error("Public selector omits a certified binding");
        bindingGroups.push({
          mapping: { ...binding.mapping },
          selectors: operation.selectors,
          bindingCount: binding.bindingCount,
        });
        const declarations = new Map(
          addressed.map((entry) => {
            const origin = {
              ...image.physical(entry.offset, Buffer.byteLength(entry.name)),
              role: entry.role,
            };
            return [declarationSiteKey(origin), origin];
          }),
        );
        atoms.push({
          bindingGroup: atoms.length,
          operation,
          plan: binding.plan,
          declarations: [...declarations.values()],
          ...(binding.coupling ? { coupling: binding.coupling } : {}),
        });
        validateAtomicBindingCoupling(atoms.at(-1), binding.bindingCount);
      }
      const physical = new Map(
        atoms.flatMap((atom) => atom.plan.edits).map((edit) => [siteKey(edit), edit]),
      );
      const plan = { id, edits: [...physical.values()] };
      notify(selection);
      commit(selection, plan);
      return {
        operation: {
          ...original,
          bindingGroups,
          bindingCertification: publicBindingCertification(bindingGroups),
        },
        plan,
        atoms,
      };
    },
  };
}

/** Plan a bounded, same-category batch for regression tests; live delivery uses the session directly. */
export async function scopedNamingPlan(tree, requests, directory) {
  if (
    !Array.isArray(requests) ||
    !requests.length ||
    requests.length > 20 ||
    new Set(requests.map((request) => request.category)).size !== 1
  )
    throw new Error("Invalid naming batch");
  const session = await scopedNamingSession(tree, directory, {
    file: requests[0].category === "helpers" ? requests[0].file : undefined,
  });
  try {
    const plans = [];
    for (const request of requests) plans.push(await session.plan(request));
    return plans;
  } finally {
    session.close();
  }
}

/** Apply one planned request against its unchanged batch snapshot and already delivered
 * edits. Offsets are live compiler origins, never canonical generation locations.
 */
export function applyScopedNamePlan(tree, plan, applied = []) {
  const byFile = new Map();
  for (const edit of plan.edits) {
    const earlier = applied
      .flatMap((item) => item.edits)
      .filter((item) => item.file === edit.file && item.start < edit.start);
    const start =
      edit.start + earlier.reduce((sum, item) => sum + item.new.length - item.old.length, 0);
    if (!byFile.has(edit.file)) byFile.set(edit.file, []);
    byFile.get(edit.file).push({ ...edit, start });
  }
  const next = { ...tree };
  for (const [file, edits] of byFile) {
    const source = tree[file];
    let cursor = 0,
      text = "";
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      if (
        edit.start < cursor ||
        source.slice(edit.start, edit.start + edit.old.length) !== edit.old
      )
        throw new Error("Stale or overlapping current binding edit");
      text += source.slice(cursor, edit.start) + edit.new;
      cursor = edit.start + edit.old.length;
    }
    next[file] = text + source.slice(cursor);
    assertNeutralSource(file, next[file]);
  }
  return next;
}
