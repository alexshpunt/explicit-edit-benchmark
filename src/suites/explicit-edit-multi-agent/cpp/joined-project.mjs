import path from "node:path";
import { includeDirectives, cppTokens } from "./cpp-tokens.mjs";

/** Build a disposable compiler view of current project source, retaining every physical
 * origin. This is not an answer tree and is never written back as candidate source.
 * Header guards and macro-controlled repeated includes keep their normal C++ behavior.
 */
export function joinedProject(
  tree,
  files = Object.keys(tree)
    .filter((file) => file.endsWith(".cpp"))
    .sort(),
) {
  let source = "";
  const spans = [],
    once = new Set();
  function append(file, start, end) {
    if (end <= start) return;
    const begin = Buffer.byteLength(source);
    source += tree[file].slice(start, end);
    spans.push({ start: begin, end: Buffer.byteLength(source), file, original: start });
  }
  function expand(file, stack = []) {
    const protectedTokens = cppTokens(tree[file]).filter(
      (token) => !/^[A-Za-z_]\w*$/.test(token.text),
    );
    const pragmaOnce = [...tree[file].matchAll(/^[ \t]*#[ \t]*pragma[ \t]+once\b/gm)].some(
      (match) =>
        !protectedTokens.some((token) => token.start <= match.index && match.index < token.end),
    );
    if (pragmaOnce) {
      if (once.has(file)) return;
      once.add(file);
    }
    if (stack.includes(file)) throw new Error("Cyclic physical include expansion");
    let cursor = 0;
    for (const include of includeDirectives(tree[file])) {
      const relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), include.file),
      );
      const target = [relative, include.file, "support/" + include.file].find(
        (candidate) => typeof tree[candidate] === "string",
      );
      if (!target) continue;
      append(file, cursor, include.start);
      source += "\n";
      expand(target, [...stack, file]);
      source += "\n";
      cursor = include.end;
    }
    append(file, cursor, tree[file].length);
  }
  for (const file of files) {
    if (typeof tree[file] !== "string") throw new Error("Missing compiler input file");
    expand(file);
    source += "\n";
  }
  const bytes = Buffer.from(source);
  function physical(offset, length) {
    const span = spans.find((item) => item.start <= offset && offset + length <= item.end);
    if (!span) throw new Error("Compiler edit crosses a physical source boundary");
    return {
      file: span.file,
      start: span.original + bytes.subarray(span.start, offset).toString("utf8").length,
    };
  }
  return { source, spans, physical };
}
