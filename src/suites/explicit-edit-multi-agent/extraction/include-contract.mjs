import assert from "node:assert/strict";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";

// Mask comments and literals for directive recognition, but mask only comments
// when reading a directive. Equal-length masks keep include offsets comparable.
function masks(source) {
  const lexical = source.split("");
  const uncommented = source.split("");
  for (const token of cppTokens(source)) {
    if (/^[A-Za-z_]\w*$/.test(token.text)) continue;
    assert.ok(
      !token.text.startsWith("//") || !/\\\r?$/.test(token.text),
      "Unsupported spliced line comment",
    );
    const comment = token.text.startsWith("//") || token.text.startsWith("/*");
    for (let at = token.start; at < token.end; at++) {
      if (source[at] === "\r" || source[at] === "\n") continue;
      lexical[at] = " ";
      if (comment) uncommented[at] = " ";
    }
  }
  return { lexical: lexical.join(""), uncommented: uncommented.join("") };
}

/** Return only include directives and their enclosing preprocessing branches.
 * The list is in directive order, with duplicates intact. It contains no source
 * bodies, offsets or names of neighbouring program entities.
 */
export function includeContract(task) {
  assert.equal(typeof task?.destination, "string");
  const source = task.destination;
  const { lexical, uncommented } = masks(source);
  assert.ok(
    !/<%|%>|\?\?<|\?\?>/.test(lexical.replace(/\\\r?\n/g, "")),
    "Unsupported alternate braces",
  );
  const includes = new Map(includeDirectives(uncommented).map((entry) => [entry.start, entry]));
  const stack = [];
  const result = [];
  let nextGroup = 1;
  // Track all possible brace depths across preprocessing branches. An include in
  // an opaque body must never turn into agent-visible source text.
  let depths = new Set([0]);
  for (let start = 0; start < source.length;) {
    let end = start;
    do {
      const newline = lexical.indexOf("\n", end);
      end = newline === -1 ? source.length : newline + 1;
    } while (end < source.length && /\\\r?\n$/.test(lexical.slice(start, end)));
    const line = lexical.slice(start, end);
    assert.ok(!/^[ \t]*(?:%:|\?\?=)/.test(line), "Unsupported alternate directive marker");
    const match = /^[ \t]*#[ \t]*([A-Za-z_]\w*)\b/.exec(line);
    if (match) {
      const kind = match[1];
      assert.ok(
        !["include_next", "import", "elifdef", "elifndef"].includes(kind),
        "Unsupported preprocessing directive",
      );
      const head = uncommented
        .slice(start, end)
        .trim()
        .replace(/\\\r?\n/g, " ");
      if (["if", "ifdef", "ifndef"].includes(kind)) {
        assert.ok(/^#[ \t]*(?:if|ifdef|ifndef)\s+\S/.test(head), "Invalid conditional head");
        stack.push({
          branches: [head],
          sawElse: false,
          entryDepths: new Set(depths),
          exitDepths: new Set(),
        });
      } else if (kind === "elif" || kind === "else") {
        const frame = stack.at(-1);
        assert.ok(frame && !frame.sawElse, "Invalid conditional branch");
        if (kind === "elif") assert.ok(/^#[ \t]*elif\s+\S/.test(head), "Invalid elif head");
        else {
          assert.match(head, /^#[ \t]*else\s*$/, "Invalid else head");
          frame.sawElse = true;
        }
        for (const depth of depths) frame.exitDepths.add(depth);
        depths = new Set(frame.entryDepths);
        frame.branches.push(head);
      } else if (kind === "endif") {
        assert.match(head, /^#[ \t]*endif\s*$/, "Invalid endif head");
        const frame = stack.pop();
        assert.ok(frame, "Unmatched endif");
        for (const depth of depths) frame.exitDepths.add(depth);
        if (!frame.sawElse) for (const depth of frame.entryDepths) frame.exitDepths.add(depth);
        depths = frame.exitDepths;
      } else if (kind === "include") {
        assert.ok(
          [...depths].every((depth) => depth === 0),
          "Include in an opaque or ambiguous scope",
        );
        const entry = includes.get(start);
        assert.ok(entry && entry.end === end, "Unsupported include directive");
        const file = entry.quoted ? `"${entry.file}"` : `<${entry.file}>`;
        for (const frame of stack) frame.group ??= nextGroup++;
        result.push({
          directive: `#include ${file}`,
          context: stack.map(({ branches }) => [...branches]),
          groups: stack.map(({ group }) => group),
        });
      }
    } else {
      assert.ok(!/\\\r?\n/.test(line), "Unsupported line splice outside a directive");
      for (const character of line) {
        const delta = character === "{" ? 1 : character === "}" ? -1 : 0;
        if (delta) depths = new Set([...depths].map((depth) => depth + delta));
      }
    }
    start = end;
  }
  assert.equal(stack.length, 0, "Unclosed conditional");
  return result;
}

/** Render an include inventory in prose, not as source or a destination template. */
export function includeContractProse(includes) {
  assert.ok(Array.isArray(includes));
  if (!includes.length) return "The destination requires no include directives.";
  return [
    "The destination requires exactly these include occurrences, in the order listed. Do not add other includes. Equal conditional-block numbers identify the same block; different numbers identify distinct blocks. Branch descriptions identify context, not source locations:",
    ...includes.map(({ directive, context, groups }, index) => {
      const branch = context.length
        ? ` Enclosing branches from outermost to innermost: ${context.map((chain, depth) => `conditional block ${groups[depth]}: ${chain.join(" followed by ")}`).join("; then ")}.`
        : " Outside conditional branches.";
      return `${index + 1}. ${directive}.${branch}`;
    }),
  ].join("\n");
}
