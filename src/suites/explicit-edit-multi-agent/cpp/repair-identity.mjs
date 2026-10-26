import { cppTokens } from "./cpp-tokens.mjs";

const empty = Object.freeze([]);
const indexes = new WeakMap();
const name = /^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/;
const keyword = new Set([
  "auto",
  "bool",
  "char",
  "char8_t",
  "char16_t",
  "char32_t",
  "double",
  "float",
  "int",
  "long",
  "short",
  "signed",
  "unsigned",
  "void",
  "wchar_t",
  "const",
  "volatile",
  "restrict",
  "__restrict",
  "__restrict__",
  "noexcept",
  "decltype",
  "typename",
  "class",
  "struct",
  "enum",
  "union",
  "template",
  "true",
  "false",
  "nullptr",
  "_Bool",
  "__int128",
]);
const clean = (value) => (typeof value === "string" ? value.replace(/^::/, "") : "");
const leaf = (value) => {
  const offset = value.lastIndexOf("::");
  return offset < 0 ? value : value.slice(offset + 2);
};

function lex(source) {
  const result = [];
  const gap = (text) => {
    const pattern =
      /(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*|(?:0[xX][\da-fA-F']+(?:\.[\da-fA-F']*)?(?:[pP][+-]?[\d']+)?|(?:[\d']+(?:\.[\d']*)?|\.[\d']+)(?:[eEpP][+-]?[\d']+)?)[A-Za-z_0-9]*|[^\s]/g;
    for (const match of text.matchAll(pattern)) result.push(match[0]);
  };
  let cursor = 0;
  for (const token of cppTokens(source).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text))) {
    gap(source.slice(cursor, token.start));
    result.push(token.text);
    cursor = token.end;
  }
  gap(source.slice(cursor));
  return result;
}

function makeIndex(bindings, aliases) {
  const rules = aliases
    .filter((item) => name.test(item?.from ?? "") && name.test(item?.to ?? ""))
    .map(({ from, to }) => ({ from: clean(from), to: clean(to) }))
    .filter((item) => item.from !== item.to);
  const branches = new Map();
  for (const rule of rules) {
    if (!branches.has(rule.from)) branches.set(rule.from, new Set());
    branches.get(rule.from).add(rule.to);
  }
  const rewrite = (value) => {
    const seen = new Set([value]);
    for (const rule of rules) {
      if (value !== rule.from && !value.startsWith(rule.from + "::")) continue;
      if (branches.get(rule.from).size > 1) return undefined;
      value = rule.to + value.slice(rule.from.length);
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  };
  const types = new Set();
  for (const binding of bindings)
    if (binding?.role === "type" && name.test(binding.scope ?? "")) types.add(clean(binding.scope));
  for (const rule of rules) {
    types.add(rule.from);
    types.add(rule.to);
  }
  const shorts = new Map();
  for (const type of types) {
    const canonical = rewrite(type);
    if (!canonical) continue;
    for (const spelling of new Set([leaf(type), leaf(canonical)])) {
      if (!shorts.has(spelling)) shorts.set(spelling, new Set());
      shorts.get(spelling).add(canonical);
    }
  }
  return { rewrite, types, shorts };
}

function indexFor(bindings, aliases) {
  if (!indexes.has(bindings)) indexes.set(bindings, new WeakMap());
  const byAlias = indexes.get(bindings);
  if (!byAlias.has(aliases)) byAlias.set(aliases, makeIndex(bindings, aliases));
  return byAlias.get(aliases);
}

/** Normalize compiler-provided signatures and public nominal type aliases.
 * Unknown spellings stay literal; ambiguous known short type names return an
 * empty identity so callers cannot merge namespaces or overloads by guessing.
 */
export function canonicalRepairSignature(
  signature,
  { scope = "", bindings = empty, aliases = empty } = {},
) {
  if (typeof signature !== "string" || !signature.trim()) return "";
  if (!Array.isArray(bindings)) bindings = empty;
  if (!Array.isArray(aliases)) aliases = empty;
  const index = indexFor(bindings, aliases);
  const prefixes = [];
  let current = clean(scope);
  while (current) {
    prefixes.push(current);
    const end = current.lastIndexOf("::");
    current = end < 0 ? "" : current.slice(0, end);
  }
  prefixes.push("");
  const normalize = (token) => {
    if (!name.test(token) || keyword.has(token)) return token;
    const value = clean(token);
    if (value.includes("::")) {
      const rewritten = index.rewrite(value);
      if (!rewritten) return undefined;
      if (rewritten.startsWith("std::")) {
        const alternatives = index.shorts.get(leaf(rewritten));
        if (!alternatives || [...alternatives].every((item) => item.startsWith("std::")))
          return rewritten.slice(5);
      }
      return rewritten;
    }
    for (const prefix of prefixes) {
      const qualified = [prefix, value].filter(Boolean).join("::");
      if (index.types.has(qualified)) return index.rewrite(qualified);
    }
    const matches = index.shorts.get(value);
    if (matches?.size > 1) return undefined;
    if (matches?.size === 1) return [...matches][0];
    return value;
  };
  let result = "",
    previous = "";
  for (const token of lex(signature)) {
    const value = normalize(token);
    if (value === undefined) return "";
    if (/[A-Za-z_0-9]$/.test(previous) && /^[A-Za-z_0-9]/.test(value)) result += " ";
    result += value;
    previous = value;
  }
  return result;
}
