import assert from "node:assert/strict";
import { includeDirectives } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { neutralSourcePath } from "../generation/origin-markers.mjs";
import { prepareHeaderExtraction } from "./plan.mjs";
import { traceGenerationOrigins } from "./provenance.mjs";
import { implementationTasks } from "./cpp-plan.mjs";
import { vendorExtractionTasks } from "./vendor-plan.mjs";

/** Build paired file assignments from the unchanged generated source and guarded ownership replay. */
export function preparePairedExtraction({ initial, headers, modules, generation, agents } = {}) {
  assert.ok(
    Array.isArray(modules) && modules.length > 0 && new Set(modules).size === modules.length,
  );
  assert.ok(modules.every((module) => typeof module === "string" && /^[A-Za-z_]\w*$/.test(module)));
  assert.ok(Array.isArray(headers));
  const provenance = traceGenerationOrigins({
    initial,
    manifest: generation?.manifest,
    mixing: generation?.mixing,
  });
  const sourceFiles = new Map(provenance.files.map((file) => [file.file, file]));
  const metadata = new Map(headers.map((header) => [header.file, header]));
  assert.equal(metadata.size, headers.length);
  for (const header of headers) {
    const original = sourceFiles.get(header.file);
    assert.ok(original);
    const guard = /^[ \t\r\n]*#[ \t]*ifndef[ \t]+([A-Za-z_]\w*)/.exec(original.text)?.[1];
    assert.ok(guard);
    assert.equal(header.guard, guard.replace("YOCTO", provenance.originName.toUpperCase()));
    const includes = includeDirectives(original.text)
      .filter((include) => include.quoted)
      .map((include) => neutralSourcePath(include.file, provenance.originName))
      .filter((file) => metadata.has(file));
    assert.deepEqual(header.includes, includes);
  }
  for (const module of modules) {
    assert.ok(
      metadata.has(`${module}.h`) && sourceFiles.has(`${module}.cpp`),
      "A selected module must have both an original header and implementation",
    );
    assert.ok(!Object.hasOwn(initial, `${module}.h`) && !Object.hasOwn(initial, `${module}.cpp`));
  }
  const implementations = implementationTasks({
    initial,
    provenance,
    files: modules.map((module) => `${module}.cpp`),
  });
  const required = new Set(modules.map((module) => `${module}.h`));
  let vendor = false;
  for (const implementation of implementations)
    for (const include of includeDirectives(implementation.destination)) {
      const local = [include.file, `support/${include.file}`].find((file) => sourceFiles.has(file));
      if (local && metadata.has(local)) required.add(local);
      else if (local?.endsWith("/stb_image_resize.h")) vendor = true;
      else if (include.quoted)
        assert.ok(
          Object.hasOwn(initial, include.file),
          "Implementation depends on an unavailable local file",
        );
    }
  const selected = new Set(),
    visiting = new Set();
  const visit = (file) => {
    if (selected.has(file)) return;
    assert.ok(
      metadata.has(file) && !visiting.has(file),
      "Missing or cyclic project-header dependency",
    );
    visiting.add(file);
    for (const dependency of metadata.get(file).includes) visit(dependency);
    visiting.delete(file);
    selected.add(file);
  };
  for (const file of required) visit(file);
  const headerPlan = prepareHeaderExtraction({ initial, headers, modules: [...selected] });
  const tasks = [
    ...headerPlan.tasks.map((task) => ({ ...task, kind: "header" })),
    ...implementations,
    ...(vendor ? vendorExtractionTasks({ initial, provenance }) : []),
  ].map((task, index) => {
    const id = `extract-${String(index + 1).padStart(3, "0")}`;
    return {
      ...task,
      id,
      fragments: task.fragments.map((fragment, index) => ({
        ...fragment,
        id: `${id}-fragment-${String(index + 1).padStart(3, "0")}`,
      })),
    };
  });
  assert.equal(new Set(tasks.map((task) => task.file)).size, tasks.length);
  const count = agents ?? Math.min(tasks.length, 10);
  assert.ok(Number.isSafeInteger(count) && 1 <= count && count <= Math.min(tasks.length, 10));
  const edits = tasks
    .flatMap((task) =>
      task.fragments.map((fragment, index) => ({
        ...fragment,
        replacement: index === 0 ? task.replacement : "",
      })),
    )
    .sort((left, right) => left.start - right.start);
  const main = [];
  let cursor = 0;
  for (const edit of edits) {
    assert.ok(cursor <= edit.start && edit.start < edit.end);
    assert.equal(initial["main.cpp"].slice(edit.start, edit.end), edit.text);
    main.push(initial["main.cpp"].slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  main.push(initial["main.cpp"].slice(cursor));
  const expected = { ...initial, "main.cpp": main.join("") };
  for (const task of tasks) {
    assert.ok(task.fragments.length > 0 && !Object.hasOwn(initial, task.file));
    expected[task.file] = task.destination;
  }
  return {
    version: "renderer-module-extraction-plan-v2",
    scope: "experimental-module-pairs",
    initial: Object.freeze({ ...initial }),
    initialIdentity: treeIdentity(initial),
    modules: [...modules],
    agents: count,
    headers,
    generation,
    tasks,
    expected,
  };
}
