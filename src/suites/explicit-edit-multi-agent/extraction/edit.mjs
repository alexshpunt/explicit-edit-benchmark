import assert from "node:assert/strict";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { cppTokens, headerSpan, includeDirectives } from "../cpp/cpp-tokens.mjs";

/** Select only this task's pieces inside its CURRENT guard envelope.
 * Repeated closing directives are selected at that envelope's end, never by a
 * global occurrence number or a stale preparation offset.
 */
export function extractCurrentHeader(before, task) {
  if (!/^[A-Za-z_][A-Za-z_0-9]*\.h$/.test(task.file) || before[task.file] !== undefined)
    throw Error("Invalid or existing extraction target");
  const source = before["main.cpp"];
  const span = headerSpan(source, task.guard);
  const body = source.slice(span.start, span.end);
  let cursor = 0;
  const edits = task.fragments.map(({ text }, index) => {
    let offset;
    if (index === 0) offset = 0;
    else if (index === task.fragments.length - 1) offset = body.length - text.length;
    else {
      offset = body.indexOf(text, cursor);
      if (offset >= 0 && body.indexOf(text, offset + 1) >= 0)
        throw Error("Ambiguous current extraction fragment");
    }
    if (offset < cursor || body.slice(offset, offset + text.length) !== text)
      throw Error("Owned current extraction fragment is missing");
    cursor = offset + text.length;
    return {
      start: span.start + offset,
      end: span.start + cursor,
      replacement: index === 0 ? task.replacement : "",
    };
  });
  let main = source;
  for (const edit of edits.reverse())
    main = main.slice(0, edit.start) + edit.replacement + main.slice(edit.end);
  return { ...before, "main.cpp": main, [task.file]: task.destination };
}

/** Match whole public file fragments against a fresh shared-source read.
 * Structural scope distinguishes implementation units; a vendor assignment owns
 * all of its complete repeated phases. Ambiguity fails instead of guessing.
 */
export function extractCurrentFile(before, task) {
  if (!task.kind || (task.kind === "header" && task.guard))
    return extractCurrentHeader(before, task);
  assert.ok(["implementation", "vendor-header", "header"].includes(task.kind));
  assert.match(task.file, /^(?:[A-Za-z_]\w*\/)*[A-Za-z_]\w*\.(?:h|cpp)$/);
  assert.ok(task.file !== "main.cpp" && !Object.hasOwn(before, task.file));
  assert.equal(typeof task.destination, "string");
  assert.equal(typeof task.replacement, "string");
  const source = before["main.cpp"];
  assert.equal(typeof source, "string");
  assert.ok(task.fragments.length > 0);
  const groups = new Map();
  for (const fragment of task.fragments) {
    assert.equal(typeof fragment.text, "string");
    assert.ok(fragment.text.trim());
    const key = JSON.stringify([
      fragment.text,
      fragment.scope,
      fragment.kind,
      fragment.beforeFragment,
      fragment.afterFragment,
    ]);
    if (!groups.has(key)) groups.set(key, { fragment, count: 0 });
    groups.get(key).count++;
  }
  let candidates = [];
  let namespaces = [];
  if (task.kind === "implementation" || task.kind === "header") {
    const structure = cppStructure(source),
      tokens = cppTokens(source);
    namespaces = structure.namespaces;
    const scopeAt = (start, end) => {
      let scope = "",
        boundary = -1;
      for (const namespace of structure.namespaces)
        if (namespace.start < start && end < namespace.end && namespace.start > boundary) {
          scope = namespace.scope;
          boundary = namespace.start;
        }
      return scope;
    };
    candidates = [
      ...structure.units,
      ...structure.directives.map((item) => ({ ...item, kind: "directive" })),
    ];
    const covered = new Uint8Array(source.length);
    for (const item of candidates) covered.fill(1, item.start, item.end);
    for (const token of tokens) {
      const comment = token.text.startsWith("//") || token.text.startsWith("/*");
      if (comment && !covered.subarray(token.start, token.end).some(Boolean))
        candidates.push({ ...token, scope: scopeAt(token.start, token.end), kind: "comment" });
      if (!/^[A-Za-z_]\w*$/.test(token.text)) covered.fill(1, token.start, token.end);
    }
    for (const namespace of structure.namespaces) {
      const semicolon = /^[ \t]*;/.exec(source.slice(namespace.end));
      if (semicolon) covered.fill(1, namespace.end, namespace.end + semicolon[0].length);
    }
    for (let start = 0; start < source.length; start++)
      if (source[start] === ";" && !covered[start])
        candidates.push({
          start,
          end: start + 1,
          scope: scopeAt(start, start + 1),
          kind: "empty-declaration",
        });
  }
  const matching = (fragment) => {
    const matches = [];
    if (task.kind === "vendor-header") {
      for (
        let start = source.indexOf(fragment.text);
        start >= 0;
        start = source.indexOf(fragment.text, start + fragment.text.length)
      )
        matches.push({ start, end: start + fragment.text.length });
    } else {
      const leading = /^\s*/.exec(fragment.text)[0].length;
      const trailing = /\s*$/.exec(fragment.text)[0].length;
      for (const candidate of candidates) {
        if (candidate.scope !== fragment.scope || candidate.kind !== fragment.kind) continue;
        const current = source.slice(candidate.start, candidate.end);
        if (current.trim() !== fragment.text.trim()) continue;
        const start = candidate.start + /^\s*/.exec(current)[0].length - leading;
        const end = candidate.end - /\s*$/.exec(current)[0].length + trailing;
        if (start >= 0 && source.slice(start, end) === fragment.text) matches.push({ start, end });
      }
    }
    return matches.sort((left, right) => left.start - right.start);
  };
  const known = [...groups.values()].flatMap(({ fragment, count }) => {
    if (fragment.beforeFragment || fragment.afterFragment) return [];
    const matches = matching(fragment);
    return matches.length === count ? matches : [];
  });
  const edits = [];
  for (const { fragment, count } of groups.values()) {
    let matches = matching(fragment);
    const anchors = [];
    for (const [field, before] of [
      ["beforeFragment", true],
      ["afterFragment", false],
    ]) {
      if (!fragment[field]) continue;
      const anchor = task.fragments.find((item) => item.id === fragment[field]);
      assert.ok(anchor, "Missing public live-context anchor");
      const locations = matching(anchor);
      assert.equal(locations.length, 1, "Live-context anchor is missing or ambiguous");
      const location = locations[0];
      anchors.push({ location, before });
      matches = matches.filter((match) =>
        before ? match.end <= location.start : location.end <= match.start,
      );
    }
    if (anchors.length) {
      matches = fragment.beforeFragment ? matches.slice(-count) : matches.slice(0, count);
      if (matches.length) {
        const gaps = [
          [matches[0].start, matches.at(-1).end],
          ...anchors.map(({ location, before }) =>
            before ? [matches.at(-1).end, location.start] : [location.end, matches[0].start],
          ),
        ];
        for (const [start, end] of gaps) {
          for (const candidate of candidates) {
            if (candidate.start < start || candidate.end > end) continue;
            const owned = [...known, ...matches].some(
              (range) => range.start <= candidate.start && candidate.end <= range.end,
            );
            const text = source.slice(candidate.start, candidate.end);
            const context =
              candidate.kind === "comment" ||
              (candidate.kind === "using" && /^using\s+(?:namespace\s+)?std\b/.test(text)) ||
              (candidate.kind === "directive" && /^\s*#\s*include\b/.test(text));
            assert.ok(owned || context, "Repeated header unit crosses foreign live context");
          }
        }
      }
    }
    assert.equal(matches.length, count, "Owned current file fragments are missing or ambiguous");
    edits.push(...matches);
  }
  if (task.kind === "header") {
    assert.ok(
      !includeDirectives(source).some((include) => include.quoted && include.file === task.file),
      "Duplicate project header include",
    );
    const first = edits.reduce((left, right) => (left.start <= right.start ? left : right));
    const point = Math.min(
      first.start,
      ...namespaces
        .filter((item) => item.start < first.start && first.end < item.end)
        .map((item) => item.start),
    );
    const prefix = source.slice(source.lastIndexOf("\n", point - 1) + 1, point);
    edits.push({
      start: point,
      end: point,
      replacement: (prefix.trim() ? "\n" : "") + task.replacement,
    });
  }
  edits.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < edits.length; index++)
    assert.ok(edits[index - 1].end <= edits[index].start);
  let main = source;
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index];
    main =
      main.slice(0, edit.start) +
      (edit.replacement ?? (index === 0 && task.kind !== "header" ? task.replacement : "")) +
      main.slice(edit.end);
  }
  return { ...before, "main.cpp": main, [task.file]: task.destination };
}
