import assert from "node:assert/strict";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { partitionFlatTask } from "./flat-batches.mjs";
import { loadFlatCase } from "./flat-case.mjs";
import { scaffoldFlatPlan } from "./flat-scaffold.mjs";
import { flatVendorContract } from "./flat-vendor-contract.mjs";
import { symbolSpecifications } from "./symbol-spec.mjs";
import { assemblyDeliveryProse, extractionProse, publicSignature } from "./assembly-prose.mjs";

export const ASSEMBLY_CASE_VERSION = "renderer-assembly-case-v1";
export const ASSEMBLY_ASSIGNMENT_BYTES = 2048;
export const ASSEMBLY_ASSIGNMENT_UNITS = 10;

/** Units an agent can find by kind, scope and signature alone. */
const NAMED_KINDS = new Set([
  "function-definition",
  "function-declaration",
  "struct",
  "class",
  "union",
  "enum",
]);

const whitespace = (text) => !text.trim();

/** Describe one source unit publicly, or return null when it has no single name. */
async function describeUnit(text, kind, scope) {
  let entities;
  try {
    entities = await symbolSpecifications(
      { fragments: [{ text, kind, scope }], using: [] },
      { allowDuplicates: true },
    );
  } catch {
    try {
      const contract = await flatVendorContract(text, "header");
      if (contract.directives.some((directive) => !directive.inside)) return null;
      entities = contract.entities.map(({ count = 1, ...entity }) => {
        assert.equal(count, 1);
        return { ...entity, scope };
      });
    } catch {
      return null;
    }
  }
  if (entities.length !== 1 || !NAMED_KINDS.has(entities[0].kind)) return null;
  const { kind: entityKind, signature } = entities[0];
  return { scope, kind: entityKind, signature: publicSignature(signature) };
}

const describeKey = ({ scope, kind, signature }) => [scope, kind, signature].join("\u0000");

/** Order header regions so every header follows the project headers it includes. */
function regionOrder(tasks, includes) {
  const headers = tasks.filter((task) => task.replacement);
  const rest = tasks.filter((task) => !task.replacement);
  const order = [];
  const placed = new Set();
  while (order.length < headers.length) {
    const next = headers.find(
      (task) =>
        !placed.has(task.file) &&
        includes
          .get(task.id)
          .every((file) => placed.has(file) || !headers.some((other) => other.file === file)),
    );
    assert.ok(next, "Cyclic project header includes");
    order.push(next);
    placed.add(next.file);
  }
  return [...order, ...rest];
}

/** Derive the two-phase assembly case from a verified flat extraction plan.
 * Agents receive only the prose of the returned deliveries; offsets, unit text
 * outside unnamed blocks and the references stay private to the controller.
 */
export async function prepareAssemblyPlan(plan) {
  const source = plan.initial?.["main.cpp"];
  assert.equal(typeof source, "string");
  assert.deepEqual(Object.keys(plan.initial), ["main.cpp"]);
  assert.ok(!source.includes("#pragma region"), "Reserved region directive in source");
  const { markers: fragmentMarkers, tree: scaffoldFiles } = scaffoldFlatPlan(plan);

  // Every unit of the original source, including residual units, competes for a description.
  const structure = cppStructure(source);
  const units = [
    ...structure.units.map((unit) => ({ ...unit, kind: "declaration" })),
    ...structure.directives.map((unit) => ({ ...unit, kind: "directive" })),
  ].sort((a, b) => a.start - b.start);
  const unitAt = new Map(units.map((unit, index) => [unit.start, index]));
  const descriptions = [];
  const byKey = new Map();
  for (const unit of units) {
    const text = source.slice(unit.start, unit.end);
    const description = await describeUnit(text, unit.kind, unit.scope ?? "");
    descriptions.push(description);
    if (!description) continue;
    const key = describeKey(description);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(text.trim());
  }
  const neighbour = (index, step) => {
    for (let at = index + step; at >= 0 && at < units.length; at += step)
      if (descriptions[at]) return descriptions[at];
    return null;
  };

  const projectFiles = new Map();
  for (const task of plan.tasks) {
    projectFiles.set(task.file, task.file);
    projectFiles.set(task.file.replace(/^support\//, ""), task.file);
  }
  const includes = new Map();
  const regions = new Map();
  const items = [];
  for (const task of plan.tasks) {
    const scaffold = scaffoldFiles[task.file];
    assert.ok(scaffold.startsWith(task.preamble), "Destination scaffold lost its preamble");
    const headerLines = [];
    const kept = [];
    const required = [];
    for (const line of task.preamble.split(/(?<=\n)/)) {
      const include = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(line);
      if (/^\s*#\s*pragma\s+once\s*$/.test(line)) headerLines.push(line.trim());
      else if (include && projectFiles.has(include[1])) {
        headerLines.push(line.trim());
        required.push(projectFiles.get(include[1]));
      } else kept.push(line);
    }
    includes.set(task.id, required);
    let body = kept.join("") + scaffold.slice(task.preamble.length);

    // Destination order in the reference decides whether neighbours can form one block.
    const placement = [];
    let cursor = task.preamble.length;
    for (const fragment of task.fragments) {
      const at = task.destination.indexOf(fragment.text, cursor);
      assert.ok(at >= cursor, "Destination fragment is missing or out of order");
      placement.push({ start: at, end: at + fragment.text.length });
      cursor = at + fragment.text.length;
    }
    const taskItems = [];
    for (const [index, fragment] of task.fragments.entries()) {
      const unitIndex = unitAt.get(fragment.start);
      assert.ok(unitIndex !== undefined, "Fragment is not a complete source unit");
      assert.equal(units[unitIndex].end, fragment.end, "Fragment is not a complete source unit");
      const description = descriptions[unitIndex];
      const previous = taskItems.at(-1);
      if (
        !description &&
        previous?.kind === "block" &&
        whitespace(source.slice(previous.end, fragment.start)) &&
        whitespace(task.destination.slice(placement[index - 1].end, placement[index].start))
      ) {
        previous.fragments.push(fragment);
        previous.end = fragment.end;
        previous.lastUnit = unitIndex;
        continue;
      }
      taskItems.push({
        id: `${task.id}-item-${taskItems.length + 1}`,
        taskId: task.id,
        file: task.file,
        kind: description ? "named" : "block",
        description,
        fragments: [fragment],
        start: fragment.start,
        end: fragment.end,
        firstUnit: unitIndex,
        lastUnit: unitIndex,
      });
    }
    for (const item of taskItems) {
      item.text = source.slice(item.start, item.end);
      const first = fragmentMarkers.get(item.fragments[0].id);
      const last = fragmentMarkers.get(item.fragments.at(-1).id);
      const from = body.indexOf(first);
      const to = body.indexOf(last) + last.length;
      assert.ok(from >= 0 && to > from && body.lastIndexOf(first) === from);
      let between = body.slice(from, to);
      for (const fragment of item.fragments)
        between = between.replace(fragmentMarkers.get(fragment.id), "");
      assert.ok(whitespace(between), "Block markers are separated by destination content");
      body = body.slice(0, from) + first + body.slice(to);
      item.marker = first;
      if (item.kind === "named") {
        const copies = byKey.get(describeKey(item.description));
        assert.ok(
          copies.every((text) => text === item.text.trim()),
          "A unit description matches different source text",
        );
        item.copies = copies.length;
      } else {
        item.before = neighbour(item.firstUnit, -1);
        item.after = neighbour(item.lastUnit, 1);
        let matches = 0;
        for (let at = source.indexOf(item.text); at >= 0; at = source.indexOf(item.text, at + 1)) {
          const first = units.findIndex((unit) => unit.start >= at);
          const last = units.findLastIndex((unit) => unit.end <= at + item.text.length);
          if (
            first >= 0 &&
            describeKey(neighbour(first, -1) ?? {}) === describeKey(item.before ?? {}) &&
            describeKey(neighbour(last, 1) ?? {}) === describeKey(item.after ?? {})
          )
            matches++;
        }
        assert.equal(matches, 1, "An unnamed block is not identified by its text and neighbours");
      }
    }
    if (!body.endsWith("\n")) body += "\n";
    regions.set(task.id, {
      taskId: task.id,
      file: task.file,
      kind: task.kind,
      headerLines,
      replacement: task.replacement,
      body,
      items: taskItems,
    });
    items.push(...taskItems);
  }

  const ordered = regionOrder(plan.tasks, includes).map((task) => regions.get(task.id));
  const open = (region) => `#pragma region ${region.file}\n`;
  const close = "#pragma endregion\n";
  const insertAt = Math.min(...items.map((item) => item.start));
  const lineStart = source.lastIndexOf("\n", insertAt - 1) + 1;
  assert.ok(whitespace(source.slice(lineStart, insertAt)), "Regions must start a line");
  const regionText = (filled) =>
    ordered.map((region) => open(region) + filled(region) + close).join("\n") + "\n";
  const fill = (region) =>
    region.items.reduce((body, item) => body.replace(item.marker, () => item.text), region.body);
  const prefix = source.slice(0, lineStart);
  let tail = "",
    position = lineStart;
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    tail += source.slice(position, item.start);
    position = item.end;
  }
  tail += source.slice(position);

  const scaffold = { "main.cpp": prefix + regionText((region) => region.body) + source.slice(lineStart) };
  const markerFree = {
    "main.cpp": prefix + regionText((region) => removeMarkers(region.body, items)) + source.slice(lineStart),
  };
  const assembled = { "main.cpp": prefix + regionText(fill) + tail };
  const final = {
    "main.cpp": prefix + ordered.map((region) => region.replacement).join("\n") + "\n" + tail,
  };
  for (const region of ordered)
    final[region.file] = region.headerLines.map((line) => line + "\n").join("") + fill(region);

  // Interleave deliveries: the first delivery of every region, then the second, and so on.
  const perRegion = [];
  for (const region of ordered) {
    const batches = await partitionFlatTask(
      { id: region.taskId, file: region.file, fragments: region.items },
      {
        maxBytes: ASSEMBLY_ASSIGNMENT_BYTES,
        maxEdits: ASSEMBLY_ASSIGNMENT_UNITS,
        render: ({ fragments }) => assemblyDeliveryProse(region, fragments),
      },
    );
    perRegion.push(batches.map((batch) => ({ ...batch, items: batch.fragments })));
  }
  const deliveries = [];
  for (let round = 0; perRegion.some((batches) => round < batches.length); round++)
    for (const batches of perRegion) if (round < batches.length) deliveries.push(batches[round]);
  for (const [index, delivery] of deliveries.entries()) delivery.queueIndex = index;
  const extractions = ordered.map((region, index) => ({
    id: `extract-region-${index + 1}`,
    taskId: region.taskId,
    file: region.file,
    prompt: extractionProse(region),
  }));
  return {
    version: ASSEMBLY_CASE_VERSION,
    regions: ordered,
    items,
    deliveries,
    extractions,
    trees: { scaffold, markerFree, assembled, final },
    identities: {
      scaffold: treeIdentity(scaffold),
      assembled: treeIdentity(assembled),
      final: treeIdentity(final),
    },
    markers: new Set(items.map((item) => item.marker)),
  };
}

function removeMarkers(text, items) {
  return items.reduce((body, item) => body.replace(item.marker, ""), text);
}

/** Remove every complete issued marker line from every text file and count them. */
export function cleanupAssemblyMarkers(tree, markers) {
  assert.ok(markers instanceof Set);
  const issued = new Set([...markers].map((marker) => marker.trim()));
  const cleaned = {};
  let remaining = 0;
  for (const [file, content] of Object.entries(tree)) {
    if (typeof content !== "string") {
      cleaned[file] = content;
      continue;
    }
    cleaned[file] = content.replace(/^[ \t]*(\/\/ __EXPLICIT_EDIT_SLOT_\d+_\d+__)[ \t]*\n/gm, (whole, marker) => {
      if (!issued.has(marker)) return whole;
      remaining++;
      return "";
    });
  }
  return { tree: cleaned, remaining };
}

/** Load a verified flat case and derive its assembly case. */
export async function prepareAssemblyCase(casePath) {
  const { plan, manifest } = await loadFlatCase(casePath);
  return { plan, manifest, ...(await prepareAssemblyPlan(plan)) };
}
