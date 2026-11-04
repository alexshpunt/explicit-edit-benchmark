import assert from "node:assert/strict";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "../generation/generator.mjs";

function layoutOnly(text) {
  let cursor = 0;
  let remainder = "";
  for (const token of cppTokens(text)) {
    if (!/^(?:\/\/|\/\*)/.test(token.text)) return false;
    remainder += text.slice(cursor, token.start);
    cursor = token.end;
  }
  return !(remainder + text.slice(cursor)).replaceAll(";", "").trim();
}

/** Create ordered destination slots and preinsert source replacements. The
 * returned plan uses the scaffolded source offsets; its expected tree remains
 * the original extraction result. Markers are private controller metadata. */
export function scaffoldFlatPlan(plan) {
  const original = plan.initial?.["main.cpp"];
  assert.equal(typeof original, "string");
  assert.ok(Array.isArray(plan.tasks) && plan.tasks.length);
  for (const content of Object.values(plan.initial)) {
    assert.equal(typeof content, "string");
    assert.ok(!content.includes("// __EXPLICIT_EDIT_SLOT_"), "Reserved marker collision");
  }
  for (const task of plan.tasks) {
    assert.equal(typeof task.destination, "string");
    assert.ok(!task.destination.includes("// __EXPLICIT_EDIT_SLOT_"), "Reserved marker collision");
  }
  const ids = new Set();
  const files = new Set(Object.keys(plan.initial));
  const ownership = [];
  const insertions = [];
  const markers = new Map();
  const targetFiles = {};
  const taskIds = new Set();
  for (const [taskIndex, task] of plan.tasks.entries()) {
    assert.ok(typeof task.id === "string" && task.id && !taskIds.has(task.id));
    taskIds.add(task.id);
    assert.ok(typeof task.file === "string" && task.file && !files.has(task.file));
    assert.ok(!task.file.startsWith("/") && !task.file.split("/").includes(".."));
    files.add(task.file);
    assert.ok(Array.isArray(task.fragments) && task.fragments.length);
    assert.equal(typeof task.destination, "string");
    assert.equal(typeof task.replacement, "string");
    assert.ok(!task.replacement || /^#include ["<][^\n]+[">]\n$/.test(task.replacement));
    assert.equal(typeof task.preamble, "string");
    assert.ok(task.destination.startsWith(task.preamble));
    assert.ok(Array.isArray(task.using ?? []));
    let cursor = 0;
    let scaffold = "";
    let previousSourceEnd = 0;
    for (const [index, fragment] of task.fragments.entries()) {
      assert.ok(typeof fragment.id === "string" && fragment.id && !ids.has(fragment.id));
      ids.add(fragment.id);
      assert.ok(Number.isSafeInteger(fragment.start) && Number.isSafeInteger(fragment.end));
      assert.ok(fragment.start >= previousSourceEnd && fragment.end > fragment.start);
      assert.equal(original.slice(fragment.start, fragment.end), fragment.text);
      previousSourceEnd = fragment.end;
      ownership.push(fragment);
      if (index === 0 && task.replacement)
        insertions.push({ at: fragment.start, text: task.replacement });
      const start = task.destination.indexOf(fragment.text, cursor);
      assert.ok(start >= cursor, "Destination fragment is missing or out of order");
      const gap = task.destination.slice(cursor, start);
      if (index === 0) {
        let position = task.preamble.length;
        for (const entry of task.using ?? []) {
          assert.equal(typeof entry.text, "string");
          assert.ok(entry.text.length);
          const found = gap.indexOf(entry.text, position);
          assert.ok(
            found >= position && layoutOnly(gap.slice(position, found)),
            "Unsupported destination prefix",
          );
          position = found + entry.text.length;
        }
        assert.ok(layoutOnly(gap.slice(position)), "Unsupported destination prefix");
      } else assert.ok(layoutOnly(gap), "Unsupported destination gap");
      const lineStart = task.destination.lastIndexOf("\n", start - 1) + 1;
      assert.ok(
        /^[ \t]*$/.test(task.destination.slice(lineStart, start)),
        "Unsupported inline fragment",
      );
      const marker = `// __EXPLICIT_EDIT_SLOT_${taskIndex + 1}_${index + 1}__\n`;
      assert.ok(
        !original.includes(marker) && !task.destination.includes(marker),
        "Marker collision",
      );
      markers.set(fragment.id, marker);
      scaffold += gap + marker;
      cursor = start + fragment.text.length;
    }
    assert.ok(layoutOnly(task.destination.slice(cursor)), "Unsupported destination tail");
    targetFiles[task.file] = scaffold + task.destination.slice(cursor);
  }
  ownership.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ownership.length; i++)
    assert.ok(ownership[i - 1].end <= ownership[i].start, "Overlapping source ownership");
  insertions.sort((a, b) => a.at - b.at);
  let source = "",
    position = 0;
  for (const insertion of insertions) {
    assert.ok(insertion.at >= position);
    source += original.slice(position, insertion.at) + insertion.text;
    position = insertion.at;
  }
  source += original.slice(position);
  const shift = (offset, inclusive) =>
    insertions
      .filter(({ at }) => at < offset || (inclusive && at === offset))
      .reduce((n, edit) => n + edit.text.length, 0);
  const tasks = plan.tasks.map((task) => ({
    ...task,
    preinsertedReplacement: true,
    fragments: task.fragments.map((fragment) => ({
      ...fragment,
      start: fragment.start + shift(fragment.start, true),
      end: fragment.end + shift(fragment.end, false),
    })),
  }));
  for (const task of tasks)
    for (const fragment of task.fragments)
      assert.equal(source.slice(fragment.start, fragment.end), fragment.text);
  const tree = { ...plan.initial, "main.cpp": source, ...targetFiles };
  return {
    plan: { ...plan, initial: tree, initialIdentity: treeIdentity(tree), tasks },
    tree,
    markers,
  };
}

/** Remove only whole, issued marker lines, leaving user code and comments. */
export function cleanupFlatScaffold(tree, markers) {
  assert.ok(markers instanceof Map);
  const issued = new Set(markers.values());
  const result = {};
  for (const [path, content] of Object.entries(tree)) {
    assert.equal(typeof content, "string");
    if (path === "main.cpp") {
      result[path] = content;
      continue;
    }
    result[path] = content.replace(
      /^([ \t]*)(\/\/ __EXPLICIT_EDIT_SLOT_\d+_\d+__\n)/gm,
      (whole, indent, marker) => (issued.has(marker) ? indent : whole),
    );
  }
  return result;
}
