import { createHash } from "node:crypto";
import { headerSpan, includeDirectives, withoutBlankLayoutLines } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "../generation/generator.mjs";

const version = "renderer-module-extraction-plan-v1";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const projectHeader = (file) =>
  typeof file === "string" && /^[A-Za-z_][A-Za-z_0-9]*\.h$/.test(file);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sourcePath = (file) =>
  typeof file === "string" &&
  !file.startsWith("/") &&
  !/[\\\x00-\x1f\x7f]/.test(file) &&
  !/^[A-Za-z]:/.test(file) &&
  file.split("/").every((part) => part && part !== "." && part !== "..");

function failure(message, cause, code = "EXTRACTION_PLAN_INVALID") {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function requirePlan(condition, message) {
  if (!condition) throw failure(message);
}

function completeSpan(source, guard, allowMissing) {
  try {
    return headerSpan(source, guard, { allowMissing });
  } catch (cause) {
    throw failure("Header provenance does not select one complete current guard", cause);
  }
}

function destinationSource(fragments, header) {
  let source = fragments.map(({ text }) => text).join("");
  const prefix = new RegExp(
    `^[ \\t]*#[ \\t]*ifndef[ \\t]+${header.guard}[ \\t]*\\r?\\n` +
      `(?:[ \\t]*\\r?\\n)*[ \\t]*#[ \\t]*define[ \\t]+${header.guard}[ \\t]*(?:\\r?\\n|$)`,
  ).exec(source);
  requirePlan(prefix, "Header has no supported guard-definition scaffold");
  const existing = new Set(
    includeDirectives(source)
      .filter(({ quoted }) => quoted)
      .map(({ file }) => file),
  );
  const missing = header.includes.filter((file) => !existing.has(file));
  const newline = prefix[0].includes("\r\n") ? "\r\n" : "\n";
  if (missing.length) {
    source =
      prefix[0] +
      missing.map((file) => `#include "${file}"${newline}`).join("") +
      source.slice(prefix[0].length);
  }
  const required = includeDirectives(source)
    .filter(({ quoted, file }) => quoted && header.includes.includes(file))
    .map(({ file }) => file);
  requirePlan(
    JSON.stringify(required) === JSON.stringify(header.includes),
    "Existing include scaffolding conflicts with the required direct include order",
  );
  return source;
}

/** Partition trusted original-header guards in the unchanged packed input.
 * Nested selected headers own their own bytes. Parent tasks receive every other
 * substantive segment, while blank boundary gaps remain unscored layout.
 * Offsets describe this immutable preparation only, not the live editing file.
 */
export function prepareHeaderExtraction({ initial, headers, modules } = {}) {
  requirePlan(
    record(initial) &&
      Object.hasOwn(initial, "main.cpp") &&
      typeof initial["main.cpp"] === "string",
    "Missing initial monolith",
  );
  for (const [file, source] of Object.entries(initial)) {
    requirePlan(sourcePath(file) && typeof source === "string", "Invalid initial source entry");
    requirePlan(Buffer.from(source).toString("utf8") === source, "Invalid initial UTF-8 source");
  }
  requirePlan(Array.isArray(headers) && headers.length > 0, "Missing header provenance");
  requirePlan(
    Array.isArray(modules) && modules.length > 0 && modules.length <= headers.length,
    "Extraction requires a nonempty registered header subset",
  );
  const metadata = new Map();
  const guards = new Set();
  for (const header of headers) {
    requirePlan(
      record(header) &&
        projectHeader(header.file) &&
        typeof header.guard === "string" &&
        /^[A-Za-z_]\w*$/.test(header.guard) &&
        Array.isArray(header.includes) &&
        header.includes.every(projectHeader) &&
        new Set(header.includes).size === header.includes.length &&
        !header.includes.includes(header.file),
      "Invalid project-header provenance",
    );
    requirePlan(
      !metadata.has(header.file) && !guards.has(header.guard),
      "Duplicate header provenance",
    );
    metadata.set(header.file, {
      file: header.file,
      guard: header.guard,
      includes: [...header.includes],
    });
    guards.add(header.guard);
  }
  const selected = new Set(modules);
  requirePlan(selected.size === modules.length, "Duplicate selected module");
  for (const file of selected) {
    requirePlan(
      metadata.has(file) && !Object.hasOwn(initial, file),
      "Missing or already extracted module",
    );
    for (const dependency of metadata.get(file).includes) {
      if (!selected.has(dependency) && !Object.hasOwn(initial, dependency)) {
        throw failure(
          "A selected module requires a header outside the available extraction subset",
          undefined,
          "EXTRACTION_DEPENDENCY_MISSING",
        );
      }
    }
  }
  const source = initial["main.cpp"];
  const spans = [];
  for (const header of metadata.values()) {
    const span = completeSpan(source, header.guard, !selected.has(header.file));
    if (span) spans.push({ ...header, ...span });
  }
  for (const outer of spans.filter(({ file }) => selected.has(file))) {
    for (const inner of spans) {
      if (inner === outer || inner.end <= outer.start || outer.end <= inner.start) continue;
      const nested = outer.start < inner.start && inner.end < outer.end;
      const containing = inner.start < outer.start && outer.end < inner.end;
      requirePlan(nested || containing, "Project-header provenance spans overlap without nesting");
      requirePlan(
        !nested || selected.has(inner.file),
        "Selected header contains an unselected project header",
      );
    }
  }
  const chosen = modules.map((file) => spans.find((span) => span.file === file));
  const tasks = chosen.map((header, index) => {
    const ancestors = chosen
      .filter((other) => other.start < header.start && header.end < other.end)
      .sort((left, right) => right.start - left.start);
    const descendants = chosen.filter(
      (other) => header.start < other.start && other.end < header.end,
    );
    const children = descendants
      .filter(
        (other) =>
          !descendants.some((parent) => parent.start < other.start && other.end < parent.end),
      )
      .sort((left, right) => left.start - right.start);
    const id = `extract-${String(index + 1).padStart(3, "0")}`;
    const fragments = [];
    let cursor = header.start;
    const append = (end) => {
      const text = source.slice(cursor, end);
      if (text.trim())
        fragments.push({
          id: `${id}-fragment-${String(fragments.length + 1).padStart(3, "0")}`,
          start: cursor,
          end,
          text,
          sha256: hash(text),
        });
    };
    for (const child of children) {
      append(child.start);
      cursor = child.end;
    }
    append(header.end);
    requirePlan(fragments.length > 0, "Selected header has no owned source fragments");
    return {
      id,
      file: header.file,
      guard: header.guard,
      includes: [...header.includes],
      parent: ancestors[0]?.file ?? null,
      fragments,
      destination: destinationSource(fragments, header),
      replacement: ancestors.length ? "" : `#include "${header.file}"\n`,
    };
  });
  const edits = tasks
    .flatMap((task) =>
      task.fragments.map((fragment, index) => ({
        ...fragment,
        replacement: index === 0 ? task.replacement : "",
      })),
    )
    .sort((left, right) => left.start - right.start);
  let cursor = 0;
  const main = [];
  for (const edit of edits) {
    requirePlan(edit.start >= cursor, "Source fragments have overlapping ownership");
    main.push(source.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  main.push(source.slice(cursor));
  const expected = { ...initial, "main.cpp": main.join("") };
  for (const task of tasks) expected[task.file] = task.destination;
  const snapshot = Object.freeze({ ...initial });
  return { version, initial: snapshot, initialIdentity: treeIdentity(snapshot), tasks, expected };
}

/** Check the complete target files and preserved residual source independently.
 * Layout-only blank lines do not create failures. Literal, comment, splice and
 * inactive-source contents remain part of the comparison. No score is inferred.
 */
export function gradeExtraction(plan, tree) {
  requirePlan(
    record(plan) &&
      [version, "renderer-module-extraction-plan-v2"].includes(plan.version) &&
      record(plan.initial) &&
      record(plan.expected) &&
      typeof plan.expected["main.cpp"] === "string" &&
      Object.values(plan.expected).every((source) => typeof source === "string") &&
      Array.isArray(plan.tasks) &&
      plan.tasks.length > 0 &&
      plan.tasks.every((task) => record(task) && typeof plan.expected[task.file] === "string"),
    "Unsupported extraction plan",
  );
  const candidate = record(tree) ? tree : {};
  const sameSource = (file) =>
    typeof candidate[file] === "string" &&
    withoutBlankLayoutLines(candidate[file]) === withoutBlankLayoutLines(plan.expected[file]);
  const files = plan.tasks.map(({ id, file }) => ({ id, file, targetMatched: sameSource(file) }));
  const mainMatched = sameSource("main.cpp");
  const inventoryMatched =
    record(tree) &&
    JSON.stringify(Object.keys(candidate).sort()) ===
      JSON.stringify(Object.keys(plan.expected).sort());
  const targets = new Set(["main.cpp", ...plan.tasks.map(({ file }) => file)]);
  const unrelatedMatched = Object.keys(plan.initial)
    .filter((file) => !targets.has(file))
    .every(sameSource);
  return {
    status:
      mainMatched &&
      inventoryMatched &&
      unrelatedMatched &&
      files.every(({ targetMatched }) => targetMatched)
        ? "pass"
        : "fail",
    files,
    mainMatched,
    inventoryMatched,
    unrelatedMatched,
  };
}

/** Retain the explicitly header-only result shape for earlier diagnostic callers. */
export function gradeHeaderExtraction(plan, tree) {
  requirePlan(plan?.version === version, "Unsupported header extraction plan");
  const { files, ...result } = gradeExtraction(plan, tree);
  return { ...result, modules: files };
}
