import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { flattenRendererNamespaces } from "./flat-namespace.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
/** Build an independently specified partial or complete reference from original offsets. */
export function flatExpected(initial, tasks) {
  const source = initial["main.cpp"];
  assert.equal(typeof source, "string");
  const operations = tasks
    .flatMap((task) =>
      task.fragments.map((fragment, index) => ({
        ...fragment,
        replacement: index === 0 ? task.replacement : "",
      })),
    )
    .sort((a, b) => a.start - b.start);
  let remaining = "",
    previous = 0;
  for (const operation of operations) {
    assert.ok(previous <= operation.start, "Overlapping extracted units");
    assert.equal(source.slice(operation.start, operation.end), operation.text);
    remaining += source.slice(previous, operation.start) + operation.replacement;
    previous = operation.end;
  }
  remaining += source.slice(previous);
  const expected = { ...initial, "main.cpp": remaining };
  for (const task of tasks) {
    assert.ok(!Object.hasOwn(expected, task.file), "Duplicate extraction target");
    expected[task.file] = task.destination;
  }
  return expected;
}
const inactivePreambles = [
  "#ifdef __CUDACC__\n#define inline inline __device__ __forceinline__\n#endif\n",
  "#ifdef FROND_EMBREE\n#include <embree4/rtcore.h>\n#endif\n",
  "#ifdef FROND_DENOISE\n#include <OpenImageDenoise/oidn.hpp>\n#endif\n",
];

/** Derive a new, snapshot-bound CPU profile from a verified legacy plan and
 * validated Clang active-line projection. The caller authenticates the legacy
 * plan and the compiler invocation before passing their output here.
 */
export function prepareFlatExtractionPlan(plan, selected) {
  const source = plan.initial?.["main.cpp"];
  assert.equal(typeof source, "string");
  assert.ok(Array.isArray(selected) && selected.length);
  assert.deepEqual(Object.keys(plan.initial), ["main.cpp"]);
  let projected = "",
    cursor = 0;
  for (const line of selected) {
    assert.ok(Number.isSafeInteger(line.start) && Number.isSafeInteger(line.end));
    assert.ok(line.start >= cursor && line.end > line.start && line.end <= source.length);
    assert.ok(line.start === 0 || source[line.start - 1] === "\n");
    assert.ok(line.end === source.length || source[line.end - 1] === "\n");
    assert.equal(source.slice(line.start, line.end), line.text);
    assert.doesNotMatch(line.text, /^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/);
    projected += source.slice(cursor, line.start).replace(/[^\n]/g, " ") + line.text;
    cursor = line.end;
  }
  projected += source.slice(cursor).replace(/[^\n]/g, " ");
  const flat = flattenRendererNamespaces(projected, "frond");
  function offset(point) {
    let delta = 0;
    for (const edit of flat.edits) {
      if (edit.start >= point) break;
      assert.ok(edit.end <= point, "Namespace edit crosses an ownership boundary");
      delta += edit.text.length - (edit.end - edit.start);
    }
    return point + delta;
  }
  const ranges = [];
  const fragmentsByTask = new Map();
  const originals = new Map(plan.tasks.map((task) => [task.id, task]));
  assert.equal(originals.size, plan.tasks.length);
  if (originals.has("extract-018") || originals.has("extract-019")) {
    assert.equal(originals.get("extract-018")?.file, "support/stb_image/stb_image_resize.h");
    assert.equal(originals.get("extract-018")?.fragments.length, 4);
    assert.equal(originals.get("extract-019")?.file, "support/stb.cpp");
  }
  for (const task of plan.tasks) {
    assert.ok(Array.isArray(task.fragments) && task.fragments.length);
    const parts = [];
    for (const [index, fragment] of task.fragments.entries()) {
      assert.ok(Number.isSafeInteger(fragment.start) && Number.isSafeInteger(fragment.end));
      assert.ok(
        fragment.start >= 0 && fragment.end > fragment.start && fragment.end <= source.length,
      );
      if (fragment.text !== undefined)
        assert.equal(
          source.slice(fragment.start, fragment.end),
          fragment.text,
          "Legacy ownership text changed",
        );
      const start = offset(fragment.start),
        end = offset(fragment.end);
      const owner = task.id === "extract-018" && [1, 3].includes(index) ? "extract-019" : task.id;
      if (owner !== task.id) assert.ok(originals.has(owner), "Missing vendor implementation owner");
      const part = { start, end, owner, inPreamble: Boolean(fragment.inPreamble) };
      ranges.push(part);
      parts.push(part);
    }
    fragmentsByTask.set(task.id, parts);
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    assert.ok(ranges[i - 1].end <= ranges[i].start, "Overlapping legacy ownership");
  const structure = cppStructure(flat.text);
  assert.equal(structure.namespaces.length, 0, "Unflattened namespace");
  const units = [
    ...structure.units,
    ...structure.directives.map((unit) => ({ ...unit, kind: "directive" })),
  ].sort((a, b) => a.start - b.start);
  const assigned = new Map(plan.tasks.map((task) => [task.id, []]));
  for (const unit of units) {
    const overlaps = ranges.filter((range) => range.start < unit.end && unit.start < range.end);
    if (!overlaps.length) continue;
    assert.ok(
      overlaps.every((range) => range.owner === overlaps[0].owner),
      "Mixed unit ownership",
    );
    let position = unit.start;
    for (const range of overlaps) {
      assert.equal(
        flat.text.slice(position, Math.max(position, range.start)).trim(),
        "",
        "Incomplete unit ownership",
      );
      position = Math.max(position, range.end);
    }
    assert.equal(flat.text.slice(position, unit.end).trim(), "", "Incomplete unit ownership");
    const list = assigned.get(overlaps[0].owner);
    list.push({
      id: `${overlaps[0].owner}-${list.length + 1}`,
      start: unit.start,
      end: unit.end,
      text: flat.text.slice(unit.start, unit.end),
      scope: unit.scope ?? "",
      kind: unit.kind,
    });
  }
  let vendorImplementation = "";
  const tasks = plan.tasks.map((original) => {
    let preamble = original.preamble ?? "";
    for (const block of inactivePreambles) preamble = preamble.replace(block, "");
    assert.doesNotMatch(
      preamble,
      /^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/m,
      "Unsupported conditional preamble",
    );
    if (original.id === "extract-018") preamble = "#pragma once\n";
    if (original.id === "extract-019") preamble = '#include "stb_image/stb_image_resize.h"\n';
    const using = (original.using ?? []).map((entry) => ({
      ...entry,
      scope: "",
      text: entry.text.replace(/\bfrond\s*::/g, ""),
    }));
    let destination = preamble + "\n" + using.map((entry) => entry.text + "\n").join("");
    for (const part of fragmentsByTask.get(original.id)) {
      const text = flat.text.slice(part.start, part.end);
      if (part.inPreamble || !text.trim()) continue;
      if (part.owner !== original.id) vendorImplementation += text + "\n";
      else destination += text + "\n";
    }
    assert.ok(assigned.get(original.id).length, "No active ownership for task");
    return {
      id: original.id,
      file: original.file,
      kind: original.kind,
      replacement: original.replacement,
      preamble,
      using,
      destination,
      fragments: assigned.get(original.id),
    };
  });
  const vendorTask = tasks.find((task) => task.id === "extract-019");
  if (vendorTask) vendorTask.destination += vendorImplementation;
  const initial = { "main.cpp": flat.text };
  const expected = flatExpected(initial, tasks);
  return {
    version: "renderer-flat-extraction-plan-v1",
    initial,
    initialIdentity: treeIdentity(initial),
    expected,
    sourceSha256: hash(source),
    projectionSha256: hash(projected),
    tasks,
  };
}
