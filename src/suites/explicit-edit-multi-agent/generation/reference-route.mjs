import { cppTokens, treeIdentity, unpack, compactBlankLines } from "./generator.mjs";
import {
  restoreFunctionLayout,
  removeGeneratedDeclarations,
} from "../tasks/restoration-layout.mjs";
import { reverseOperation } from "./inverse.mjs";
import { restorationTargets } from "../tasks/restoration-targets.mjs";
import {
  maskOrigin,
  neutralFiles,
  neutralSourcePath,
  assertNeutralSource,
} from "./origin-markers.mjs";

function tracked(text) {
  return { text, tokens: cppTokens(text).map((token, id) => ({ ...token, ids: [id] })) };
}

function slice(block, start, end) {
  const tokens = [];
  for (const token of block.tokens) {
    if (token.end <= start || token.start >= end) continue;
    if (token.start < start || token.end > end) throw new Error("Extraction cuts a token");
    tokens.push({ ...token, start: token.start - start, end: token.end - start });
  }
  return { text: block.text.slice(start, end), tokens };
}

function join(blocks) {
  let text = "";
  const tokens = [];
  for (const block of blocks) {
    for (const token of block.tokens)
      tokens.push({ ...token, start: token.start + text.length, end: token.end + text.length });
    text += block.text;
  }
  return { text, tokens };
}

function retokenize(block, text) {
  const tokens = cppTokens(text);
  if (tokens.length !== block.tokens.length) throw new Error("Packing changed token structure");
  return {
    text,
    tokens: tokens.map((token, index) => ({ ...token, ids: block.tokens[index].ids })),
  };
}

function extract(tree, record) {
  const plain = Object.fromEntries(Object.entries(tree).map(([name, block]) => [name, block.text]));
  const restored = unpack(plain, record);
  const { source, target, repeat } = record.operation;
  const block = tree[target];
  let extracted = slice(block, record.sourceStart, record.sourceStart + record.sourceLength);
  // Macro-controlled vendor headers can have rename coverage in different copies.
  // Combine their physical-token origins instead of discarding the active second copy.
  if (repeat) {
    for (const edit of record.edits.slice(1)) {
      const duplicate = slice(block, edit.start, edit.start + record.sourceLength);
      if (duplicate.text !== extracted.text) throw new Error("Repeated source differs");
      for (const [index, token] of extracted.tokens.entries())
        token.ids = [...token.ids, ...duplicate.tokens[index].ids];
    }
  }
  const parts = [];
  let cursor = 0;
  for (const edit of record.edits) {
    parts.push(slice(block, cursor, edit.start), {
      text: edit.removed,
      tokens: cppTokens(edit.removed).map((token) => ({ ...token, ids: [] })),
    });
    cursor = edit.start + edit.insertedLength;
  }
  parts.push(slice(block, cursor, block.text.length));
  const next = {
    ...tree,
    [target]: join(parts),
    [source]: retokenize(extracted, restored[source]),
  };
  if (
    treeIdentity(
      Object.fromEntries(Object.entries(next).map(([name, item]) => [name, item.text])),
    ) !== record.before
  )
    throw new Error("Tracked extraction identity differs");
  return next;
}

function render(tree, base, layer, origin, { helpers = true } = {}) {
  const rendered = Object.fromEntries(
    Object.entries(tree)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, block]) => {
        let text = "",
          cursor = 0;
        for (const token of block.tokens) {
          const changed = new Set(
            token.ids
              .map((id) => layer[id].text)
              .filter((value, index) => value !== base[token.ids[index]].text),
          );
          if (changed.size > 1) throw new Error("Repeated source has incompatible naming");
          const spelling = changed.size
            ? [...changed][0]
            : helpers && token.ids.length
              ? base[token.ids[0]].text
              : token.text;
          text += block.text.slice(cursor, token.start) + spelling;
          cursor = token.end;
        }
        text += block.text.slice(cursor);
        if (origin) text = maskOrigin({ "main.cpp": text }, { name: origin.name }).tree["main.cpp"];
        return [name, text];
      }),
  );
  return origin ? neutralFiles(rendered, origin.name) : rendered;
}

/** Derive structure-first reference states from the supplied payload and guarded records.
 * Token origins carry binding-specific names across file extraction, including repeated headers.
 * No fixture, old source tree or compiler session is used. Stages are generator checkpoints,
 * not the future atomic requests given to an agent.
 */
function preparedReference(payload, manifest) {
  if (treeIdentity(payload) !== manifest.final)
    throw new Error("Final packed tree identity does not match");
  const states = [payload];
  let current = payload;
  for (const record of [...manifest.operations].reverse()) {
    current = reverseOperation(current, record);
    states.push(current);
  }
  if (treeIdentity(current) !== manifest.initial)
    throw new Error("Complete inverse identity does not match");
  states.reverse();
  const records = manifest.operations;
  const packingCount = records.findIndex((record) => !record.operation);
  const count = packingCount < 0 ? records.length : packingCount;
  if (!count || Object.keys(states[count]).join() !== "main.cpp")
    throw new Error("Missing packing-only monolith");
  const naming = [];
  let tailStarted = false;
  for (let index = count; index < records.length; index++) {
    if (records[index].kind === "rename") {
      if (tailStarted) throw new Error("Naming must follow packing and precede mixing");
      naming.push(index);
    } else tailStarted = true;
  }
  const origin = records.find((record) => record.kind === "origin-markers");
  const base = cppTokens(states[count]["main.cpp"]);
  const layers = [base, ...naming.map((index) => cppTokens(states[index + 1]["main.cpp"]))];
  for (const layer of layers) {
    if (layer.length !== base.length) throw new Error("Naming changed token structure");
  }
  const stages = [{ phase: "initial", action: "monolith", tree: payload }];
  const add = (phase, action, tree) => {
    if (treeIdentity(tree) !== treeIdentity(stages.at(-1).tree))
      stages.push({ phase, action, tree });
  };
  // Reverse layout/mixing before extraction, without exposing any restored names.
  for (let index = records.length - 1; index >= count + naming.length; index--) {
    if (records[index].kind === "origin-markers") continue;
    const tree = Object.fromEntries(
      Object.entries(states[index]).map(([name, text]) => [
        name,
        origin && index < records.indexOf(origin)
          ? maskOrigin({ "main.cpp": text }, { name: origin.name }).tree["main.cpp"]
          : text,
      ]),
    );
    add("structure", `undo-${records[index].kind}`, tree);
  }
  let source = { "main.cpp": tracked(states[count]["main.cpp"]) };
  const fullNames = layers.at(-1);
  add("structure", "restore-definition-layout", render(source, base, fullNames, origin));
  for (let index = count - 1; index >= 0; index--) {
    source = extract(source, records[index]);
    add(
      "structure",
      `extract:${origin ? neutralSourcePath(records[index].operation.source, origin.name) : records[index].operation.source}`,
      render(source, base, fullNames, origin),
    );
  }
  const canonical = origin
    ? neutralFiles(
        Object.fromEntries(
          Object.entries(current).map(([file, text]) => [
            file,
            maskOrigin({ "main.cpp": text }, { name: origin.name }).tree["main.cpp"],
          ]),
        ),
        origin.name,
      )
    : current;
  const final = treeIdentity(canonical);
  if (origin)
    for (const stage of stages)
      for (const [file, text] of Object.entries(stage.tree)) assertNeutralSource(file, text);
  return {
    initial: manifest.final,
    final,
    stages,
    source,
    base,
    layers,
    naming,
    records,
    origin,
    states,
  };
}

/** Yield small neutral layout-reference transitions before any file extraction or name restoration.
 * Reverse only private origin/spacing bookkeeping; public states remain compact and neutral.
 * Each step swaps two whole definitions or removes one generated declaration. The compiler
 * and renderer still have to verify every state; these are not independent agent edits.
 */
export function* referenceLayoutSteps(payload, manifest) {
  if (treeIdentity(payload) !== manifest.final)
    throw new Error("Final packed tree identity differs");
  const origins = manifest.operations.filter((record) => record.kind === "origin-markers");
  if (origins.length !== 1) throw new Error("Missing or ambiguous neutral origin");
  let current = payload;
  let index = 0;
  for (const record of [...manifest.operations].reverse()) {
    if (record.kind === "rename" || record.operation) break;
    if (["origin-markers", "compact"].includes(record.kind)) {
      current = reverseOperation(current, record);
      continue;
    }
    const iterator =
      record.kind === "function-permutation"
        ? restoreFunctionLayout(current, record)
        : record.kind === "function-declarations"
          ? removeGeneratedDeclarations(current, record)
          : null;
    if (!iterator) throw new Error(`Unsupported layout operation: ${record.kind}`);
    for (const step of iterator) {
      const tree = compactBlankLines(maskOrigin(step.tree, { name: origins[0].name }).tree).tree;
      for (const [file, source] of Object.entries(tree)) assertNeutralSource(file, source);
      yield { ...step, target: `layout-${++index}`, tree };
    }
    current = reverseOperation(current, record);
  }
}
/** Map recorded declarations into a private phase-start reference tree for prompt preparation.
 * These token origins are trusted bookkeeping only. Public requests receive current
 * owner/signature descriptors, never these coordinates or reference bodies.
 */
export function referenceBindingLocations(payload, manifest, category) {
  const context = preparedReference(payload, manifest);
  const { source, base, layers, naming, records, origin, states } = context;
  const index = naming.findIndex((position) => records[position].category === category);
  if (index < 0) throw new Error("Missing naming category");
  const record = records[naming[index]];
  const tree = render(source, base, layers[index + 1], origin);
  const locations = new Map();
  for (const [originalFile, block] of Object.entries(source)) {
    const file = neutralSourcePath(originalFile, origin.name);
    const tokens = cppTokens(tree[file]);
    if (tokens.length !== block.tokens.length)
      throw new Error("Reference declaration token coverage differs");
    for (const [position, token] of block.tokens.entries())
      for (const id of token.ids) {
        if (!locations.has(id)) locations.set(id, []);
        locations.get(id).push({ file, start: tokens[position].start });
      }
  }
  const before = states[naming[index]]["main.cpp"];
  const tokensByByte = new Map();
  let cursor = 0,
    byte = 0;
  for (const [id, token] of layers[index].entries()) {
    byte += Buffer.byteLength(before.slice(cursor, token.start));
    tokensByByte.set(byte, id);
    cursor = token.start;
  }
  const families = new Map();
  for (const entry of record.selection) {
    const id = tokensByByte.get(entry.offset);
    const sites = locations.get(id);
    if (id === undefined || !sites?.length) throw new Error("Missing reference declaration origin");
    const family = entry.family.replace(/\byocto\b/g, origin.name);
    if (!families.has(family)) families.set(family, []);
    for (const site of sites) {
      if (tree[site.file].slice(site.start, site.start + entry.newName.length) !== entry.newName)
        throw new Error("Reference declaration spelling differs");
      families.get(family).push(site);
    }
  }
  return { tree, families };
}
/** Derive the existing generator-level structure-first route, preserving its checkpoint contract. */
export function referenceRoute(payload, manifest) {
  const context = preparedReference(payload, manifest);
  const { source, base, layers, naming, records, origin, stages } = context;
  const add = (action, tree) => {
    if (treeIdentity(tree) !== treeIdentity(stages.at(-1).tree))
      stages.push({ phase: "names", action, tree });
  };
  for (let index = naming.length - 1; index >= 0; index--)
    add(`restore:${records[naming[index]].category}`, render(source, base, layers[index], origin));
  add("restore:translation-unit-helpers", render(source, base, base, origin, { helpers: false }));
  if (treeIdentity(stages.at(-1).tree) !== context.final)
    throw new Error("Reference final identity differs");
  return { initial: context.initial, final: context.final, stages };
}

/** Yield private per-owner/family naming states after all original files have been extracted.
 * Physical compiler-bound token families follow code through extraction and repeated headers.
 * The iterator does not retain thousands of full trees. These are reference states, not
 * independent agent execution, and still require build/render verification before use.
 */
export function* referenceNameSteps(payload, manifest) {
  const context = preparedReference(payload, manifest);
  const targets = restorationTargets(manifest);
  const { source, base, layers, naming, records, origin } = context;
  const current = layers.at(-1).map((token) => ({ ...token }));
  const filesById = new Map();
  for (const [file, block] of Object.entries(source))
    for (const token of block.tokens)
      for (const id of token.ids) {
        if (!filesById.has(id)) filesById.set(id, new Set());
        filesById.get(id).add(file);
      }
  let latest = render(source, base, current, origin);
  const changedTree = (ids) => {
    const files = new Set(ids.flatMap((id) => [...(filesById.get(id) ?? [])]));
    const next = { ...latest };
    for (const file of files) {
      const changed = render({ [file]: source[file] }, base, current, origin);
      for (const [name, text] of Object.entries(changed)) {
        assertNeutralSource(name, text);
        next[name] = text;
      }
    }
    latest = next;
    return next;
  };
  const neutral = (family) => family.replace(/\byocto\b/g, origin.name);
  for (let index = naming.length - 1; index >= 0; index--) {
    const record = records[naming[index]];
    const groups = targets.naming.filter((group) => group.category === record.category);
    const owners = new Map();
    for (const group of groups)
      for (const family of group.families) owners.set(family.id, group.id);
    const tokenIds = new Map(layers[index].map((token, id) => [token.start, id]));
    const edits = new Map(groups.map((group) => [group.id, []]));
    const covered = new Set();
    for (const edit of record.edits) {
      if (!edit.families?.length) throw new Error("Missing physical binding coverage");
      const families = edit.families.map(neutral);
      const selected = new Set(families.map((family) => owners.get(family)));
      if (selected.size !== 1 || selected.has(undefined))
        throw new Error("Physical binding coverage crosses atomic target groups");
      const id = tokenIds.get(edit.start);
      if (
        id === undefined ||
        layers[index][id].text !== edit.old ||
        layers[index + 1][id].text !== edit.new
      )
        throw new Error("Physical binding coverage does not match recorded tokens");
      edits.get([...selected][0]).push(id);
      for (const family of families) covered.add(family);
    }
    if ([...owners.keys()].some((family) => !covered.has(family)))
      throw new Error("Incomplete physical binding coverage");
    for (const group of groups) {
      for (const id of edits.get(group.id)) current[id].text = layers[index][id].text;
      yield {
        phase: "names",
        target: group.id,
        category: group.category,
        tree: changedTree(edits.get(group.id)),
      };
    }
  }
  for (const [index, helper] of targets.helpers.entries()) {
    const file = Object.keys(source).find(
      (name) => neutralSourcePath(name, origin.name) === helper.file,
    );
    if (!file) throw new Error("Missing helper owner source");
    const changed = [];
    for (const token of source[file].tokens) {
      if (token.text !== helper.to) continue;
      for (const id of token.ids) {
        if (base[id].text !== helper.from) throw new Error("Conflicting helper token ownership");
        current[id].text = helper.to;
        changed.push(id);
      }
    }
    if (!changed.length) throw new Error("Missing helper binding coverage");
    yield {
      phase: "names",
      target: `helper-${index + 1}`,
      category: "helpers",
      tree: changedTree(changed),
    };
  }
  if (treeIdentity(render(source, base, current, origin)) !== context.final)
    throw new Error("Atomic naming reference final identity differs");
}
