import assert from "node:assert/strict";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";

function tokens(source) {
  let text = "",
    cursor = 0;
  for (const token of cppTokens(source)) {
    text += source.slice(cursor, token.start).replace(/\s/g, "") + token.text;
    cursor = token.end;
  }
  return text + source.slice(cursor).replace(/\s/g, "");
}
function units(source) {
  return cppStructure(source)
    .units.filter((unit) => unit.kind !== "using")
    .map((unit) => JSON.stringify([unit.scope, tokens(source.slice(unit.start, unit.end))]));
}

/** Compare all current physical code owners and protected tokens with the private
 * reference endpoint. Formatting and harmless namespace wrappers may differ; missing,
 * copied, renamed or changed bodies cannot hide behind identical rendered pixels.
 */
export function assertFullEndpoint(tree, expected) {
  assert.deepEqual(Object.keys(tree).sort(), Object.keys(expected).sort(), "Wrong restored files");
  for (const [file, source] of Object.entries(tree)) {
    assertNeutralSource(file, source);
    assert.deepEqual(
      units(source),
      units(expected[file]),
      `Restored physical owners or bodies differ: ${file}`,
    );
    const directives = (source) =>
      cppStructure(source)
        .directives.filter((item) => !/^#\s*include\b/.test(item.text))
        .map((item) => JSON.stringify([item.scope, tokens(item.text)]));
    assert.deepEqual(
      directives(source),
      directives(expected[file]),
      `Compiler directives differ: ${file}`,
    );
    const includes = (source) =>
      [
        ...new Set(
          includeDirectives(source).map((item) => JSON.stringify([item.file, item.quoted])),
        ),
      ].sort();
    assert.deepEqual(includes(source), includes(expected[file]), `Direct includes differ: ${file}`);
  }
}
