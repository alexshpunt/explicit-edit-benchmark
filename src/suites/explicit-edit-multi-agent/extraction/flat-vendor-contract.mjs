import assert from "node:assert/strict";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { preambleContract } from "./preamble-contract.mjs";
import { vendorSymbolSpecifications } from "./symbol-vendor.mjs";

/** Describe active vendor source without exposing function bodies or macro replacements. */
export async function flatVendorContract(source, role) {
  assert.equal(typeof source, "string");
  assert.doesNotMatch(source, /\\\r?\n/, "Unsupported spliced source");
  assert.ok(["header", "implementation"].includes(role));
  const protectedTokens = cppTokens(source).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  const chars = source.split("");
  const directives = [];
  let end = 0;
  for (const match of source.matchAll(/^[ \t]*#[^\n]*(?:\n|$)/gm)) {
    const start = match.index;
    if (start < end || protectedTokens.some((token) => token.start <= start && start < token.end))
      continue;
    end = start + match[0].length;
    const text = source.slice(start, end);
    assert.doesNotMatch(
      text,
      /^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/,
      "Unresolved vendor conditional",
    );
    directives.push({ text, start, end });
    for (let at = start; at < end; at++)
      if (chars[at] !== "\n" && chars[at] !== "\r") chars[at] = " ";
  }
  const barriers = preambleContract(directives.map(({ text }) => text).join(""));
  assert.equal(barriers.length, directives.length);
  const masked = chars.join("");
  const units = cppStructure(masked).units;
  const containers = new Map();
  for (const [index, directive] of directives.entries()) {
    const containing = units.filter(
      (unit) => unit.start < directive.start && directive.end <= unit.end,
    );
    assert.ok(containing.length <= 1, "Ambiguous directive container");
    if (!containing.length) continue;
    const unit = containing[0];
    if (!containers.has(unit.start)) {
      const definitions = await vendorSymbolSpecifications({
        kind: "vendor-header",
        fragments: [{ text: masked.slice(unit.start, unit.end) }],
      });
      assert.equal(definitions.length, 1, "Unsupported directive container");
      assert.equal(definitions[0].kind, "function-definition", "Unsupported directive container");
      containers.set(unit.start, {
        kind: definitions[0].kind,
        signature: definitions[0].signature,
      });
    }
    barriers[index].inside = containers.get(unit.start);
  }
  const entities = await vendorSymbolSpecifications({
    kind: "vendor-header",
    fragments: [{ text: masked }],
  });
  return { version: "flat-vendor-contract-v1", role, directives: barriers, entities };
}
