import assert from "node:assert/strict";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { cppStructure } from "../cpp/cpp-structure.mjs";

/** Remove supported project namespace shells and qualify explicit std::hash specializations.
 * The returned edits refer to the original input, so an owner map can replay them.
 * This is a syntactic operation: callers must also compile and verify bindings.
 */
export function flattenRendererNamespaces(source, project) {
  assert.match(project, /^[A-Za-z_]\w*$/);
  const masked = source.split("");
  const hide = (start, end) => {
    for (let i = start; i < end; i++) if (masked[i] !== "\n" && masked[i] !== "\r") masked[i] = " ";
  };
  for (const token of cppTokens(source))
    if (!/^[A-Za-z_]\w*$/.test(token.text)) hide(token.start, token.end);
  let mask = masked.join("");
  for (const match of mask.matchAll(/^[ \t]*#[^\n]*(?:\\\r?\n[^\n]*)*/gm)) {
    assert.ok(!new RegExp(`\\b${project}\\s*::`).test(match[0]), "Namespace in directive");
    hide(match.index, match.index + match[0].length);
  }
  mask = masked.join("");
  const edits = [];
  const namespace = /\bnamespace\s+([A-Za-z_]\w*)\s*\{/g;
  for (const match of mask.matchAll(namespace)) {
    assert.ok(match[1] === project || match[1] === "std", "Unsupported namespace");
    const begin = match.index + match[0].length;
    let depth = 1,
      end = begin;
    for (; end < mask.length && depth; end++) {
      if (mask[end] === "{") depth++;
      else if (mask[end] === "}") depth--;
    }
    assert.equal(depth, 0, "Unclosed namespace");
    if (match[1] === "std") {
      const inner = source.slice(begin, end - 1);
      const structure = cppStructure(inner);
      assert.equal(structure.namespaces.length + structure.directives.length, 0);
      assert.ok(structure.units.length > 0);
      let cursor = 0;
      for (const unit of structure.units) {
        assert.equal(inner.slice(cursor, unit.start).trim(), "");
        const declaration = inner.slice(unit.start, unit.end);
        const head = /^\s*template\s*<\s*>\s*struct\s+(hash)\s*</.exec(declaration);
        assert.ok(head, "Unsupported std specialization");
        const pos = begin + unit.start + head[0].lastIndexOf("hash");
        edits.push({ start: pos, end: pos, text: "std::" });
        cursor = unit.end;
      }
      assert.equal(inner.slice(cursor).trim(), "");
    }
    edits.push({ start: match.index, end: begin, text: "" }, { start: end - 1, end, text: "" });
  }
  for (const match of mask.matchAll(
    new RegExp(`\\busing\\s+namespace\\s+${project}\\s*;|\\b${project}\\s*::`, "g"),
  ))
    edits.push({ start: match.index, end: match.index + match[0].length, text: "" });
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let text = "",
    cursor = 0;
  for (const edit of edits) {
    assert.ok(cursor <= edit.start, "Overlapping namespace edits");
    text += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  text += source.slice(cursor);
  return { text, edits };
}
