import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { cppTokens, headerSpan, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "../generation/generator.mjs";

const vendor = "support/stb_image/stb_image_resize.h";
const activation = "support/stb.cpp";
const guard = "STBIR_INCLUDE_STB_IMAGE_RESIZE_H";
const macro = "STB_IMAGE_RESIZE_IMPLEMENTATION";
const hash = (text) => createHash("sha256").update(text).digest("hex");
function withoutComments(text) {
  let result = "",
    cursor = 0;
  for (const token of cppTokens(text)) {
    if (!token.text.startsWith("//") && !token.text.startsWith("/*")) continue;
    result += text.slice(cursor, token.start) + token.text.replace(/[^\r\n]/g, " ");
    cursor = token.end;
  }
  return result + text.slice(cursor);
}
function verifyRun(source, run) {
  assert.equal(run.role, "source");
  assert.ok(
    Number.isSafeInteger(run.start) &&
      Number.isSafeInteger(run.end) &&
      0 <= run.start &&
      run.start < run.end &&
      run.end <= source.length,
  );
  assert.equal(source.slice(run.start, run.end), run.text);
  assert.ok(Array.isArray(run.embedding) && run.embedding.length > 0);
}
function include(entry) {
  const directives = includeDirectives(entry.text);
  assert.equal(directives.length, 1);
  const directive = directives[0];
  assert.equal(
    withoutComments(entry.text.slice(0, directive.start) + entry.text.slice(directive.end)).trim(),
    "",
  );
  assert.ok(
    [
      directive.file,
      path.posix.join(path.posix.dirname(entry.file), directive.file),
      `support/${directive.file}`,
    ].includes(vendor),
  );
  return directive;
}
function phases(copy) {
  const structure = cppStructure(copy.text);
  assert.equal(structure.units.length, 2);
  assert.equal(structure.directives.length, 0);
  assert.equal(structure.namespaces.length, 0);
  const [declaration, implementation] = structure.units;
  assert.equal(declaration.kind, "conditional");
  assert.equal(implementation.kind, "conditional");
  assert.match(
    withoutComments(declaration.condition).trim(),
    new RegExp(`^#\\s*ifndef\\s+${guard}$`),
  );
  assert.match(
    withoutComments(implementation.condition).trim(),
    new RegExp(`^#\\s*ifdef\\s+${macro}$`),
  );
  const span = headerSpan(copy.text, guard);
  assert.equal(span.start, declaration.start);
  assert.equal(span.end, declaration.end);
  assert.equal(
    withoutComments(
      copy.text.slice(0, declaration.start) +
        copy.text.slice(declaration.end, implementation.start) +
        copy.text.slice(implementation.end),
    ).trim(),
    "",
  );
  return [
    {
      start: copy.start,
      end: copy.start + declaration.end,
      text: copy.text.slice(0, declaration.end),
    },
    { start: copy.start + declaration.end, end: copy.end, text: copy.text.slice(declaration.end) },
  ];
}

/** Preserve the two current vendor copies while exposing declarations and one activated implementation. */
export function vendorExtractionTasks({ initial, provenance, startIndex = 0 }) {
  assert.equal(treeIdentity(initial), provenance.initialIdentity);
  assert.ok(Number.isSafeInteger(startIndex) && startIndex >= 0);
  assert.ok(provenance.files.some((file) => file.file === vendor));
  assert.ok(provenance.files.some((file) => file.file === activation));
  assert.ok(!Object.hasOwn(initial, vendor) && !Object.hasOwn(initial, activation));
  const source = initial["main.cpp"];
  assert.equal(typeof source, "string");
  const vendorIncludes = provenance.removedIncludes.filter((entry) => entry.included === vendor);
  assert.equal(vendorIncludes.length, 2);
  const activationIncludes = vendorIncludes.filter((entry) => entry.file === activation);
  const declarationIncludes = vendorIncludes.filter(
    (entry) => entry.file !== activation && entry.file.endsWith("_image.cpp"),
  );
  assert.equal(activationIncludes.length, 1);
  assert.equal(declarationIncludes.length, 1);
  const activationInclude = activationIncludes[0],
    declarationInclude = declarationIncludes[0];
  assert.equal(include(activationInclude).quoted, true);
  include(declarationInclude);
  const copies = new Map();
  for (const run of provenance.runs.filter((entry) => entry.file === vendor)) {
    verifyRun(source, run);
    const embedding = run.embedding.at(-1);
    const entry = vendorIncludes.find(
      (candidate) =>
        candidate.originalFile === embedding.originalFile &&
        candidate.originalStart === embedding.originalStart,
    );
    assert.ok(entry, "A vendor copy has no matching containing-source include");
    const key = entry.file;
    const previous = copies.get(key);
    if (previous) {
      assert.equal(previous.end, run.start);
      previous.end = run.end;
      previous.text += run.text;
    } else copies.set(key, { start: run.start, end: run.end, text: run.text });
  }
  assert.equal(copies.size, 2);
  const declarationCopy = copies.get(declarationInclude.file),
    implementationCopy = copies.get(activation);
  assert.ok(declarationCopy && implementationCopy);
  assert.ok(declarationCopy.end <= implementationCopy.start);
  const activationRuns = provenance.runs
    .filter((run) => run.file === activation)
    .sort((left, right) => left.start - right.start);
  for (const run of activationRuns) verifyRun(source, run);
  const activationFragments = activationRuns
    .filter((run) => run.text.trim())
    .map((run) => ({ start: run.start, end: run.end, text: run.text }));
  assert.equal(
    withoutComments(activationFragments.map((fragment) => fragment.text).join("")).trim(),
    `#define ${macro}`,
  );
  assert.ok(
    activationFragments.every(
      (fragment) =>
        declarationCopy.end <= fragment.start && fragment.end <= implementationCopy.start,
    ),
  );
  const id = `extract-${String(startIndex + 1).padStart(3, "0")}`;
  const layout = [
    { prefix: "", suffix: "" },
    { prefix: "\n#if 0\n", suffix: "\n#endif\n" },
    { prefix: "\n#if 0\n", suffix: "\n#endif\n" },
    { prefix: "", suffix: "\n" },
  ];
  const fragments = [...phases(declarationCopy), ...phases(implementationCopy)].map(
    (fragment, index) => ({
      ...fragment,
      id: `${id}-fragment-${String(index + 1).padStart(3, "0")}`,
      sha256: hash(fragment.text),
      scope: "",
      kind: "conditional",
      ...layout[index],
    }),
  );
  const header = {
    id,
    file: vendor,
    kind: "vendor-header",
    guard,
    parent: null,
    includes: [],
    fragments,
    preamble: "",
    postamble: "",
    destination: fragments
      .map((fragment) => fragment.prefix + fragment.text + fragment.suffix)
      .join(""),
    replacement: `#include "${vendor}"\n`,
  };
  const implementationId = `extract-${String(startIndex + 2).padStart(3, "0")}`;
  const implementationFragments = activationFragments.map((fragment, index) => ({
    ...fragment,
    id: `${implementationId}-fragment-${String(index + 1).padStart(3, "0")}`,
    sha256: hash(fragment.text),
    scope: "",
    kind: "directive",
    prefix: "",
    suffix: "",
  }));
  const implementation = {
    id: implementationId,
    file: activation,
    kind: "implementation",
    guard: null,
    parent: null,
    includes: [vendor],
    fragments: implementationFragments,
    preamble: "",
    postamble: activationInclude.text,
    destination:
      implementationFragments.map((fragment) => fragment.text).join("") + activationInclude.text,
    replacement: "",
  };
  const all = [header, implementation]
    .flatMap((task) => task.fragments)
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < all.length; index++)
    assert.ok(all[index - 1].end <= all[index].start);
  return [header, implementation];
}
