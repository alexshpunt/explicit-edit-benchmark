import { createHash } from "node:crypto";
import path from "node:path";
import { cppStructure, unitDeclarator } from "../cpp/cpp-structure.mjs";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";

// Keep token boundaries and protected literals. In particular, `+ +` is not `++`.
function tokens(source) {
  const result = [];
  const gap = (text) =>
    result.push(
      ...(text.match(
        /(?:\d+(?:\.\d*)?(?:[eEpP][+-]?\d+)?[\w]*)|(?:->\*|<<=|>>=|\.\.\.|::|->|\.\*|\+\+|--|&&|\|\||==|!=|<=|>=|<<|>>|[+*/%&|^-]=)|[^\s]/g,
      ) ?? []),
    );
  let cursor = 0;
  for (const token of cppTokens(source)) {
    gap(source.slice(cursor, token.start));
    result.push(token.text);
    cursor = token.end;
  }
  gap(source.slice(cursor));
  return result;
}

// cppStructure keeps conditionals whole for moves. Grading looks inside each branch
// so independent declarations may be reordered without losing inactive alternatives.
function branches(source) {
  const protectedTokens = cppTokens(source).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  const directives = [
    ...logicalDirectives(source)
      .map((match) => Object.assign(match, { directiveKind: /^\s*#\s*(\w+)/.exec(match[0])?.[1] }))
      .filter((match) => /^(?:if|ifdef|ifndef|else|elif|endif)$/.test(match.directiveKind ?? "")),
  ].filter(
    (match) =>
      !protectedTokens.some((token) => token.start <= match.index && match.index < token.end),
  );
  const parts = [];
  let depth = 0,
    start = 0,
    condition;
  for (const match of directives) {
    if (["if", "ifdef", "ifndef"].includes(match.directiveKind)) {
      if (depth === 0) {
        condition = tokens(match[0]);
        start = match.index + match[0].length;
      }
      depth++;
    } else if (match.directiveKind === "endif") {
      depth--;
      if (depth === 0) parts.push({ condition, source: source.slice(start, match.index), start });
    } else if (depth === 1) {
      parts.push({ condition, source: source.slice(start, match.index), start });
      condition = tokens(match[0]);
      start = match.index + match[0].length;
    }
  }
  if (depth || !parts.length) throw Error("Incomplete conditional contract");
  return parts;
}

function directiveTokens(text) {
  const define = /^#\s*define\s+([A-Za-z_]\w*)(\()?/.exec(text.trim());
  return [...(define ? [define[2] ? "function-macro" : "object-macro"] : []), ...tokens(text)];
}

function logicalDirectives(source) {
  const protectedTokens = cppTokens(source).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  return [...source.matchAll(/^[ \t]*#(?:[^\n\\]|\\[^\r\n]|\\\r?\n)*(?:\n|$)/gm)].filter(
    (match) =>
      !protectedTokens.some((token) => token.start <= match.index && match.index < token.end),
  );
}
function macroNames(source) {
  return logicalDirectives(source)
    .map((match) => /^\s*#\s*(?:define|undef)\s+([A-Za-z_]\w*)/.exec(match[0])?.[1])
    .filter(Boolean);
}
function inventory(tree) {
  const records = [];
  function visit(file, source, inheritedScope = "", conditions = [], inheritedMacros = "") {
    const structure = cppStructure(source);
    const events = structure.directives
      .filter((item) => /^#\s*(?:define|undef)\b/.test(item.text))
      .map((item) => ({
        position: item.end,
        names: macroNames(item.text),
        tokens: directiveTokens(item.text),
      }));
    for (const unit of structure.units.filter((item) => item.kind === "conditional")) {
      const text = source.slice(unit.start, unit.end);
      const directives = logicalDirectives(text);
      if (directives.some((match) => /^\s*#\s*(?:define|undef)\b/.test(match[0])))
        events.push({
          position: unit.end,
          names: macroNames(text),
          tokens: directives
            .filter((match) => !/^\s*#\s*include\b/.test(match[0]))
            .map((match) => directiveTokens(match[0])),
        });
    }
    events.sort((a, b) => a.position - b.position);
    const context = (position, text) => {
      const needed = new Set(
        cppTokens(text)
          .filter((token) => /^[A-Za-z_]\w*$/.test(token.text))
          .map((token) => token.text),
      );
      const available = events.filter((item) => item.position <= position);
      let previousSize;
      do {
        previousSize = needed.size;
        for (const item of available.filter((event) =>
          event.names.some((name) => needed.has(name)),
        ))
          for (const token of item.tokens.flat(Infinity))
            if (/^[A-Za-z_]\w*$/.test(token)) needed.add(token);
      } while (needed.size !== previousSize);
      return createHash("sha256")
        .update(
          JSON.stringify([
            inheritedMacros,
            available
              .filter((item) => item.names.some((name) => needed.has(name)))
              .map((item) => item.tokens),
          ]),
        )
        .digest("hex");
    };
    for (const unit of structure.units) {
      const scope = [inheritedScope, unit.scope].filter(Boolean).join("::");
      const text = source.slice(unit.start, unit.end);
      if (unit.kind === "using") {
        records.push({ file, scope, conditions, kind: "using", tokens: tokens(text) });
        continue;
      }
      if (unit.kind === "conditional") {
        const macros = context(unit.start, text);
        const parts = branches(text);
        const before = records.length;
        try {
          for (const part of parts)
            visit(file, part.source, scope, [...conditions, part.condition], macros);
          // Include-only preambles may differ: the compiler checks their usefulness.
          if (records.length > before)
            records.push({
              file,
              scope,
              conditions,
              kind: "branches",
              macros,
              tokens: parts.map((part) => part.condition),
            });
        } catch {
          // Some fixture declarations span mutually exclusive branches (extern-C
          // wrappers and macro-selected declaration tails). They are one physical
          // unit, not independently reorderable declarations.
          records.length = before;
          records.push({
            file,
            scope,
            conditions,
            macros,
            kind: "conditional",
            tokens: tokens(text),
            directives: logicalDirectives(text).map((match) => directiveTokens(match[0])),
          });
        }
      } else
        records.push({
          file,
          scope,
          conditions,
          kind: "owner",
          macros: context(unit.start, text),
          selector: unitDeclarator(source, unit),
          tokens: tokens(text),
        });
    }
    for (const directive of structure.directives) {
      if (/^#\s*include\b/.test(directive.text)) continue;
      records.push({
        file,
        scope: [inheritedScope, directive.scope].filter(Boolean).join("::"),
        conditions,
        kind: "directive",
        macros: context(directive.start, directive.text),
        tokens: directiveTokens(directive.text),
      });
    }
  }
  for (const [file, source] of Object.entries(tree)) {
    assertNeutralSource(file, source);
    for (const token of cppTokens(source).filter((item) => /^(?:\/\/|\/\*)/.test(item.text)))
      records.push({ file, kind: "comment", tokens: [token.text] });
    visit(file, source);
  }
  const entries = new Map();
  for (const record of records) {
    const key = JSON.stringify(record);
    if (!entries.has(key)) entries.set(key, { ...record, count: 0, key });
    if (record.kind === "using") entries.get(key).count = 1;
    else entries.get(key).count++;
  }
  return entries;
}

// Check bounded standard import context, not arbitrary C++ namespace equivalence.
// Aliases, broad namespace directives and conditional imports stay physical.
function standardUsingContext(tree, record, omitOwn = false) {
  if (record.kind !== "using" || record.conditions.length) return false;
  const spelling = record.tokens.join("");
  const literalNamespace = spelling === "usingnamespacestd::string_literals;";
  const name = /^usingstd::([A-Za-z_]\w*);$/.exec(spelling)?.[1];
  const literalUse = (token, index, all) =>
    token.text === "s" && all[index - 1]?.text.endsWith('"') && all[index - 1].end === token.start;
  if (!name && !literalNamespace) return false;
  const containsScope = (outer, inner) =>
    !outer || outer === inner || inner.startsWith(`${outer}::`);
  const containsConditions = (outer, inner) =>
    outer.length <= inner.length &&
    outer.every((condition, index) => JSON.stringify(condition) === JSON.stringify(inner[index]));
  const declarations = new Map();
  function structure(source) {
    if (!declarations.has(source)) declarations.set(source, cppStructure(source));
    return declarations.get(source);
  }
  function guardedHeader(file, source, unit, parts) {
    if (!file.endsWith(".h") || unit.scope || parts.length !== 1) return false;
    const guard = /^\s*#\s*ifndef\s+([A-Za-z_]\w*)\s*\n\s*#\s*define\s+\1\s*\n/.exec(source);
    return Boolean(guard && !source.slice(0, unit.start).trim() && !source.slice(unit.end).trim());
  }
  function available(
    file,
    source,
    scope,
    conditions,
    offset,
    limit,
    wantedScope,
    wantedConditions,
    seen,
  ) {
    const syntax = structure(source);
    for (const unit of syntax.units) {
      if (offset + unit.start >= limit) continue;
      const owner = [scope, unit.scope].filter(Boolean).join("::");
      const text = source.slice(unit.start, unit.end);
      if (
        unit.kind === "using" &&
        offset + unit.end <= limit &&
        containsScope(owner, wantedScope) &&
        containsConditions(conditions, wantedConditions) &&
        tokens(text).join("") === spelling &&
        !(omitOwn && file === record.file && owner === record.scope && !conditions.length)
      )
        return true;
      if (unit.kind === "conditional") {
        const parts = branches(text);
        const guard = guardedHeader(file, source, unit, parts);
        for (const part of parts) {
          const nested = guard ? conditions : [...conditions, part.condition];
          if (
            containsConditions(nested, wantedConditions) &&
            available(
              file,
              part.source,
              owner,
              nested,
              offset + unit.start + part.start,
              limit,
              wantedScope,
              wantedConditions,
              seen,
            )
          )
            return true;
        }
      }
    }
    for (const directive of syntax.directives) {
      if (offset + directive.end > limit) continue;
      const include = /^\s*#\s*include\s*["<]([^">]+)[">]/.exec(directive.text)?.[1];
      if (!include || !containsConditions(conditions, wantedConditions)) continue;
      const included = [
        path.posix.join(path.posix.dirname(file), include),
        include,
        `support/${include}`,
      ].find((candidate) => Object.hasOwn(tree, candidate));
      if (!included || seen.has(included)) continue;
      const owner = [scope, directive.scope].filter(Boolean).join("::");
      if (
        available(
          included,
          tree[included],
          owner,
          conditions,
          0,
          Infinity,
          wantedScope,
          wantedConditions,
          new Set([...seen, included]),
        )
      )
        return true;
    }
    return false;
  }
  function consumers(source, scope = "", conditions = [], offset = 0) {
    if (literalNamespace && !cppTokens(source).some(literalUse)) return true;
    for (const unit of structure(source).units) {
      const owner = [scope, unit.scope].filter(Boolean).join("::");
      const text = source.slice(unit.start, unit.end);
      if (unit.kind === "conditional") {
        for (const part of branches(text))
          if (
            !consumers(
              part.source,
              owner,
              [...conditions, part.condition],
              offset + unit.start + part.start,
            )
          )
            return false;
      } else if (unit.kind !== "using" && containsScope(record.scope, owner)) {
        const uses = cppTokens(text).some((token, index, all) =>
          literalNamespace
            ? literalUse(token, index, all)
            : token.text === name && !/(?:::|\.|->)\s*$/.test(text.slice(0, token.start)),
        );
        if (
          uses &&
          !available(
            record.file,
            tree[record.file],
            "",
            [],
            0,
            offset + unit.start,
            owner,
            conditions,
            new Set([record.file]),
          )
        )
          return false;
      }
    }
    return true;
  }
  try {
    return consumers(tree[record.file]);
  } catch {
    // Unsupported lexical contexts never grant a preservation exception.
    return false;
  }
}
/** Seal the cumulative permitted code, binding names, branch contexts and physical
 * module ownership at a task endpoint. This private contract contains no source-order
 * requirement. It must never be mounted in the candidate or editing executor.
 */
export function prepareCoherentContract(expected) {
  return {
    version: "renderer-coherent-contract-v1",
    files: Object.keys(expected).sort(),
    obligations: [...inventory(expected).values()].map(({ key, ...record }) => ({
      ...record,
      id: createHash("sha256").update(key).digest("hex"),
    })),
  };
}

/** Evaluate every cumulative obligation and unexpected construct independently.
 * Simple unconditional standard using-declarations may be supplied before consumers
 * through project headers, or removed when only qualified uses remain. Namespace
 * literal directives may move if their consumers retain context. Extra standard
 * imports must be unused or already supplied by headers. Other namespace directives,
 * aliases and conditional imports still require their physical records.
 * A partial result is diagnostic only. A passing contract still requires a fresh
 * isolated compilation and both repeated scenes; it is not a C++ equivalence proof.
 */
export function evaluateCoherentContract(tree, contract) {
  const obligations = [];
  const add = (id, status, detail) => obligations.push({ id, status, ...detail });
  add(
    "files",
    JSON.stringify(Object.keys(tree).sort()) === JSON.stringify(contract.files) ? "pass" : "fail",
    { kind: "files", expected: contract.files, actual: Object.keys(tree).sort() },
  );
  let actual;
  try {
    actual = inventory(tree);
  } catch (error) {
    add("source", "fail", { kind: "source", message: error.message });
  }
  const current = [...(actual?.values() ?? [])];
  const sameImport = (left, right) =>
    left.kind === "using" &&
    right.kind === "using" &&
    left.scope === right.scope &&
    JSON.stringify(left.conditions) === JSON.stringify(right.conditions) &&
    JSON.stringify(left.tokens) === JSON.stringify(right.tokens);
  for (const { id, count, ...record } of contract.obligations) {
    const key = JSON.stringify(record);
    const found = actual?.get(key)?.count ?? 0;
    const literalNamespace =
      record.kind === "using" &&
      !record.conditions.length &&
      record.tokens.join("") === "usingnamespacestd::string_literals;";
    const context = Boolean(actual) && standardUsingContext(tree, record);
    const inherited =
      found === 0 &&
      context &&
      (!literalNamespace || current.some((item) => sameImport(item, record)));
    add(id, (found === count && (!literalNamespace || context)) || inherited ? "pass" : "fail", {
      kind: record.kind,
      file: record.file,
      scope: record.scope,
      selector: record.selector,
      expected: count,
      actual: found,
      ...(inherited ? { context: "inherited-or-unused" } : {}),
    });
    actual?.delete(key);
  }
  for (const record of actual?.values() ?? []) {
    const literalNamespace =
      record.kind === "using" &&
      !record.conditions.length &&
      record.tokens.join("") === "usingnamespacestd::string_literals;";
    const harmless = literalNamespace
      ? contract.obligations.some((item) => sameImport(item, record)) &&
        standardUsingContext(tree, record)
      : standardUsingContext(tree, record, true);
    add(createHash("sha256").update(record.key).digest("hex"), harmless ? "pass" : "fail", {
      kind: harmless ? "using-context" : "unexpected",
      file: record.file,
      scope: record.scope,
      selector: record.selector,
      actual: record.count,
    });
  }
  const passed = obligations.filter((item) => item.status === "pass").length;
  return {
    status: passed === obligations.length ? "pass" : "fail",
    passed,
    total: obligations.length,
    obligations,
  };
}
