import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { neutralSourcePath } from "../generation/origin-markers.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const standardUsing = (text) => /^using\s+(?:namespace\s+)?std\b/.test(text);
function preprocessorOnly(text) {
  const comments = cppTokens(text).filter(
    (token) => token.text.startsWith("//") || token.text.startsWith("/*"),
  );
  for (const token of comments.reverse())
    text = text.slice(0, token.start) + token.text.replace(/[^\r\n]/g, " ") + text.slice(token.end);
  text = text.replace(/^[ \t]*#(?:[^\n\\]|\\(?:\r?\n|[^\r\n]))*(?:\r?\n|$)/gm, "");
  assert.equal(text.trim(), "", "Implementation preamble contains substantive code");
}
function wrapped(scope, text) {
  assert.match(scope, /^(?:[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)?$/);
  return scope ? `namespace ${scope} {\n${text}\n}\n` : `${text}\n`;
}

/** Build complete implementation assignments from current physical units and replayed file ownership. */
export function implementationTasks({ initial, provenance, files, startIndex = 0 }) {
  assert.equal(treeIdentity(initial), provenance.initialIdentity);
  assert.ok(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length);
  assert.ok(Number.isSafeInteger(startIndex) && startIndex >= 0);
  const source = initial["main.cpp"];
  assert.equal(typeof source, "string");
  const metadata = new Map(provenance.files.map((file) => [file.file, file]));
  for (const file of files) {
    assert.match(file, /^[A-Za-z_]\w*\.cpp$/);
    assert.ok(file !== "main.cpp" && metadata.has(file) && !Object.hasOwn(initial, file));
  }
  const ownerNames = [],
    ownerIds = new Map();
  const ownerId = (file) => {
    if (!ownerIds.has(file)) {
      ownerIds.set(file, ownerNames.length);
      ownerNames.push(file);
    }
    return ownerIds.get(file);
  };
  const owners = new Uint32Array(source.length);
  let cursor = 0;
  for (const run of provenance.runs) {
    assert.equal(run.start, cursor);
    assert.equal(run.text, source.slice(run.start, run.end));
    assert.equal(run.end, run.start + run.text.length);
    owners.fill(ownerId(run.file), run.start, run.end);
    cursor = run.end;
  }
  assert.equal(cursor, source.length);
  const namesIn = (start, end) => {
    const result = new Set();
    for (let position = start; position < end; position++)
      if (!/\s/.test(source[position])) result.add(ownerNames[owners[position]]);
    return [...result];
  };
  const structure = cppStructure(source),
    tokens = cppTokens(source);
  const scopeAt = (start, end) => {
    let scope = "",
      boundary = -1;
    for (const namespace of structure.namespaces) {
      if (namespace.start < start && end < namespace.end && boundary < namespace.start) {
        scope = namespace.scope;
        boundary = namespace.start;
      }
    }
    return scope;
  };
  const comments = tokens.filter(
    (token) => token.text.startsWith("//") || token.text.startsWith("/*"),
  );
  const protectedBytes = new Uint8Array(source.length);
  for (const token of tokens)
    if (!/^[A-Za-z_]\w*$/.test(token.text)) protectedBytes.fill(1, token.start, token.end);
  const namespaceShells = [];
  for (const namespace of structure.namespaces) {
    let opening = namespace.start;
    while (opening < namespace.end && (source[opening] !== "{" || protectedBytes[opening]))
      opening++;
    assert.ok(opening < namespace.end && source[namespace.end - 1] === "}");
    namespaceShells.push(
      { start: namespace.start, end: opening + 1 },
      { start: namespace.end - 1, end: namespace.end },
    );
    const semicolon = /^[ \t]*;/.exec(source.slice(namespace.end));
    if (semicolon)
      namespaceShells.push({ start: namespace.end, end: namespace.end + semicolon[0].length });
  }
  return files.map((file, index) => {
    const original = metadata.get(file),
      originalStructure = cppStructure(original.text);
    assert.ok(
      originalStructure.namespaces.length > 0,
      "Implementation has no supported namespace envelope",
    );
    const prefixEnd = Math.min(...originalStructure.namespaces.map((namespace) => namespace.start));
    const originalPrefix = original.text.slice(0, prefixEnd);
    preprocessorOnly(originalPrefix);
    const originalIncludes = includeDirectives(originalPrefix);
    const restored = provenance.removedIncludes
      .filter((entry) => entry.file === file && entry.originalStart < prefixEnd)
      .map((entry) => {
        const directive = originalIncludes.find(
          (include) => include.start <= entry.originalStart && entry.originalStart < include.end,
        );
        assert.ok(directive);
        assert.deepEqual(
          includeDirectives(entry.text).map(({ file, quoted }) => ({ file, quoted })),
          [
            {
              file: neutralSourcePath(directive.file, provenance.originName),
              quoted: directive.quoted,
            },
          ],
        );
        return { ...entry, directive };
      })
      .sort((left, right) => left.directive.start - right.directive.start);
    const prefixParts = [],
      preambleParts = [];
    let originalCursor = 0;
    for (const entry of restored) {
      assert.ok(originalCursor <= entry.directive.start);
      const pieces = provenance.project(file, originalCursor, entry.directive.start);
      prefixParts.push(...pieces);
      preambleParts.push(...pieces.map((piece) => piece.text), entry.text);
      originalCursor = entry.directive.end;
    }
    const remainder = provenance.project(file, originalCursor, prefixEnd);
    prefixParts.push(...remainder);
    preambleParts.push(...remainder.map((piece) => piece.text));
    for (const piece of prefixParts) {
      assert.equal(piece.text, source.slice(piece.start, piece.end));
      assert.ok(namesIn(piece.start, piece.end).every((owner) => owner === file));
    }
    const preamble = preambleParts.join("");
    preprocessorOnly(preamble);
    const expectedIncludes = includeDirectives(originalPrefix).map((include) => ({
      file: neutralSourcePath(include.file, provenance.originName),
      quoted: include.quoted,
    }));
    assert.deepEqual(
      includeDirectives(preamble).map(({ file, quoted }) => ({ file, quoted })),
      expectedIncludes,
    );
    const includes = includeDirectives(preamble)
      .filter((include) => include.quoted)
      .map((include) => include.file);
    const classified = new Uint8Array(source.length),
      fragments = [],
      using = [];
    const mark = (range) => classified.fill(1, range.start, range.end);
    prefixParts.forEach(mark);
    namespaceShells.forEach(mark);
    const add = (range, scope, kind) => {
      assert.ok(namesIn(range.start, range.end).every((owner) => owner === file));
      fragments.push({
        start: range.start,
        end: range.end,
        text: source.slice(range.start, range.end),
        scope,
        kind,
      });
      mark(range);
    };
    for (const unit of structure.units) {
      const unitOwners = namesIn(unit.start, unit.end);
      if (!unitOwners.includes(file)) continue;
      assert.deepEqual(unitOwners, [file], "A source unit crosses implementation owners");
      const already = classified.subarray(unit.start, unit.end);
      if (already.every((value) => value === 1)) continue;
      assert.ok(
        !already.some((value) => value === 1),
        "A source unit crosses retained scaffolding",
      );
      const text = source.slice(unit.start, unit.end);
      if (unit.kind === "using" && standardUsing(text)) {
        using.push({ scope: unit.scope, text });
        mark(unit);
      } else add(unit, unit.scope, unit.kind);
    }
    for (const directive of structure.directives) {
      const directiveOwners = namesIn(directive.start, directive.end);
      if (!directiveOwners.includes(file)) continue;
      assert.deepEqual(directiveOwners, [file]);
      if (classified.subarray(directive.start, directive.end).every((value) => value === 1))
        continue;
      assert.ok(!classified.subarray(directive.start, directive.end).some((value) => value === 1));
      add(directive, directive.scope, "directive");
    }
    for (const comment of comments) {
      const commentOwners = namesIn(comment.start, comment.end);
      if (!commentOwners.includes(file)) continue;
      assert.deepEqual(commentOwners, [file]);
      if (classified.subarray(comment.start, comment.end).every((value) => value === 1)) continue;
      assert.ok(!classified.subarray(comment.start, comment.end).some((value) => value === 1));
      add(comment, scopeAt(comment.start, comment.end), "comment");
    }
    const fileId = ownerIds.get(file);
    // Empty declarations are legal gap bytes outside the generator's moved function spans.
    for (let position = 0; position < source.length; position++) {
      if (
        owners[position] !== fileId ||
        classified[position] ||
        protectedBytes[position] ||
        source[position] !== ";"
      )
        continue;
      add(
        { start: position, end: position + 1 },
        scopeAt(position, position + 1),
        "empty-declaration",
      );
    }
    for (let position = 0; position < source.length; position++)
      if (owners[position] === fileId && !/\s/.test(source[position]))
        assert.equal(classified[position], 1, `Unclassified implementation byte at ${position}`);
    fragments.sort((left, right) => left.start - right.start);
    assert.ok(fragments.length > 0);
    const id = `extract-${String(startIndex + index + 1).padStart(3, "0")}`;
    const finalFragments = fragments.map((fragment, number) => ({
      ...fragment,
      id: `${id}-fragment-${String(number + 1).padStart(3, "0")}`,
      sha256: hash(fragment.text),
    }));
    const usingGroups = new Map();
    for (const item of using) {
      if (!usingGroups.has(item.scope)) usingGroups.set(item.scope, []);
      if (!usingGroups.get(item.scope).includes(item.text))
        usingGroups.get(item.scope).push(item.text);
    }
    let destination = preamble + (preamble.endsWith("\n") ? "" : "\n");
    for (const [scope, statements] of usingGroups)
      destination += wrapped(scope, statements.join("\n"));
    let scope = null,
      group = [];
    const flush = () => {
      if (group.length) destination += wrapped(scope, group.join("\n"));
      group = [];
    };
    for (const fragment of finalFragments) {
      if (scope !== fragment.scope) {
        flush();
        scope = fragment.scope;
      }
      group.push(fragment.text);
    }
    flush();
    return {
      id,
      file,
      kind: "implementation",
      guard: null,
      parent: null,
      includes: [...new Set(includes)],
      preamble,
      using,
      fragments: finalFragments,
      destination,
      replacement: "",
    };
  });
}
