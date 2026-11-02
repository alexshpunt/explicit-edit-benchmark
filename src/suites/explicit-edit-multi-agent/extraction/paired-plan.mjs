import assert from "node:assert/strict";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { neutralSourcePath } from "../generation/origin-markers.mjs";
import { prepareHeaderExtraction } from "./plan.mjs";
import { traceGenerationOrigins } from "./provenance.mjs";
import { implementationTasks } from "./cpp-plan.mjs";
import { vendorExtractionTasks } from "./vendor-plan.mjs";
import { stripProjectGuards } from "../generation/project-header-guards.mjs";

/** Require self-contained project-header macro scopes before extraction. */
function requireMacroIndependentHeaders(provenance, headers) {
  const own = new Map(headers.map((header) => [header.file, header]));
  const sources = new Map();
  const logicalSources = new Map();
  const writes = new Map();
  for (const file of provenance.files) {
    let source = file.text;
    if (own.has(file.file)) {
      const guard = /^[ \t\r\n]*#[ \t]*ifndef[ \t]+([A-Za-z_]\w*)/.exec(source)?.[1];
      source = stripProjectGuards({ "main.cpp": source }, [{ file: file.file, guard }]).tree[
        "main.cpp"
      ];
    }
    source = source.replace(/\\\r?\n/g, "");
    logicalSources.set(file.file, source);
    let masked = "",
      cursor = 0;
    for (const token of cppTokens(source)) {
      if (/^[A-Za-z_]\w*$/.test(token.text)) continue;
      masked += source.slice(cursor, token.start) + token.text.replace(/[^\r\n]/g, " ");
      cursor = token.end;
    }
    masked += source.slice(cursor);
    sources.set(file.file, masked);
    for (const match of masked.matchAll(/^[ \t]*#[ \t]*(define|undef)[ \t]+([A-Za-z_]\w*)/gm)) {
      if (!writes.has(match[2])) writes.set(match[2], []);
      writes.get(match[2]).push({ file: file.file, kind: match[1], start: match.index });
    }
  }
  const used = new Set(
    [...own.keys()].flatMap((file) => cppTokens(sources.get(file)).map((token) => token.text)),
  );
  for (const [macro, entries] of writes) {
    if (!used.has(macro)) continue;
    const files = new Set(entries.map((entry) => entry.file));
    for (const file of files) {
      assert.ok(
        own.has(file),
        "Project-header macro dependencies require an order-preserving extraction contract",
      );
      const source = sources.get(file);
      const local = entries.filter((entry) => entry.file === file);
      const scopes = [
        ...source.matchAll(
          /^[ \t]*#[ \t]*(if|ifdef|ifndef)[ \t]+([^\n]+)\n[ \t]*#[ \t]*(define|undef)[ \t]+([A-Za-z_]\w*)[^\n]*\n[ \t]*#[ \t]*endif[ \t]*(?:\n|$)/gm,
        ),
      ].filter((match) => match[4] === macro);
      // A temporary header-local override must be undone under the same stable
      // condition at EOF, with no include while the override is in force.
      assert.ok(
        local.length === 2 &&
          local[0].kind === "define" &&
          local[1].kind === "undef" &&
          scopes.length === 2 &&
          scopes[0][3] === "define" &&
          scopes[1][3] === "undef",
        "Unsupported project-header macro lifetime",
      );
      const [opening, closing] = scopes;
      const logical = logicalSources.get(file);
      const condition = (match) =>
        logical.slice(match.index, logical.indexOf("\n", match.index)).trim();
      assert.equal(condition(opening), condition(closing));
      assert.ok(
        !cppTokens(opening[2]).some((token) => writes.has(token.text)),
        "Mutable macro-scope condition",
      );
      assert.match(source.slice(closing.index + closing[0].length), /^[\s};]*$/);
      assert.ok(
        !/^[ \t]*#[ \t]*include\b/m.test(
          source.slice(opening.index + opening[0].length, closing.index),
        ),
      );
    }
  }
}
/** Derive whole-file assignments from replayed ownership; fresh cases strip project guards. */
export function preparePairedExtraction({
  initial,
  headers,
  modules,
  generation,
  agents,
  headerProtection = "pragma-once",
} = {}) {
  assert.ok(["pragma-once", "guard"].includes(headerProtection));
  const pragma = headerProtection === "pragma-once";
  let parentInitial;
  if (pragma) {
    const last = generation?.manifest?.operations?.at(-1);
    if (last?.kind === "project-header-guards") {
      assert.deepEqual(
        last.headers,
        headers.map(({ file, guard }) => ({ file, guard })),
      );
      parentInitial = last.before;
    } else {
      const normalized = stripProjectGuards(initial, headers);
      parentInitial = normalized.record.before;
      initial = normalized.tree;
      generation = {
        ...generation,
        manifest: {
          ...generation.manifest,
          final: normalized.record.after,
          operations: [...generation.manifest.operations, normalized.record],
        },
      };
    }
  }
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
  if (pragma) requireMacroIndependentHeaders(provenance, headers);
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
  const mainIncludes = [...selected].sort();
  const headerTasks = pragma
    ? implementationTasks({ initial, provenance, files: mainIncludes, kind: "header" }).map(
        (task) => ({
          ...task,
          replacement: `#include "${task.file}"\n`,
        }),
      )
    : prepareHeaderExtraction({ initial, headers, modules: [...selected] }).tasks.map((task) => ({
        ...task,
        kind: "header",
      }));
  const tasks = [
    ...headerTasks,
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
  const source = initial["main.cpp"];
  const namespaces = pragma ? cppStructure(source).namespaces : [];
  const insertions = pragma
    ? headerTasks.map((task) => {
        const first = task.fragments[0];
        const point = Math.min(
          first.start,
          ...namespaces
            .filter((item) => item.start < first.start && first.end < item.end)
            .map((item) => item.start),
        );
        const prefix = source.slice(source.lastIndexOf("\n", point - 1) + 1, point);
        return {
          start: point,
          end: point,
          text: "",
          replacement: (prefix.trim() ? "\n" : "") + task.replacement,
        };
      })
    : [];
  const edits = [
    ...tasks.flatMap((task) =>
      task.fragments.map((fragment, index) => ({
        ...fragment,
        replacement: index === 0 && !(pragma && task.kind === "header") ? task.replacement : "",
      })),
    ),
    ...insertions,
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const main = [];
  let cursor = 0;
  for (const edit of edits) {
    assert.ok(cursor <= edit.start && edit.start <= edit.end);
    assert.equal(initial["main.cpp"].slice(edit.start, edit.end), edit.text);
    main.push(initial["main.cpp"].slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  main.push(initial["main.cpp"].slice(cursor));
  const expected = {
    ...initial,
    "main.cpp": main.join(""),
  };
  for (const task of tasks) {
    assert.ok(task.fragments.length > 0 && !Object.hasOwn(initial, task.file));
    expected[task.file] = task.destination;
  }
  return {
    version: pragma ? "renderer-module-extraction-plan-v3" : "renderer-module-extraction-plan-v2",
    ...(pragma ? { headerProtection, parentInitial } : {}),
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
