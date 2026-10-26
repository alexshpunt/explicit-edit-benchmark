// This lexer protects comments and literals. It does not resolve C++ bindings;
// callers must restrict edits to the supported, unambiguous fixture targets.

/** Ignore blank layout lines, but retain blank lines inside literals/comments or after a splice. */
export function withoutBlankLayoutLines(text) {
  const protectedTokens = cppTokens(text).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  let offset = 0;
  let result = "";
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0];
    const protectedLine = protectedTokens.some(
      (token) => token.start <= offset && offset < token.end,
    );
    if (line.trim() || protectedLine || /\\\r?\n$/.test(text.slice(0, offset))) result += line;
    offset += line.length;
  }
  return result;
}

/** Tokenize identifiers and protected comments/literals in the supported fixture syntax. */
export function cppTokens(text) {
  const pattern =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?:u8|u|U|L)?R"([^\s()\\]{0,16})\([\s\S]*?\)\1"|(?:u8|u|U|L)?"(?:\\[\s\S]|[^"\\])*"|(?:u8|u|U|L)?'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_][A-Za-z_0-9]*/g;
  return [...text.matchAll(pattern)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Locate plain include directives, ignoring literals, comments and continued macro lines. */
export function includeDirectives(text) {
  const protectedTokens = cppTokens(text).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  return [
    ...text.matchAll(
      /^[ \t]*#[ \t]*include[ \t]+(?:"([^"\r\n]+)"|<([^>\r\n]+)>)[ \t]*(?:\r?\n|$)/gm,
    ),
  ]
    .filter(
      (match) =>
        !protectedTokens.some((token) => token.start <= match.index && match.index < token.end) &&
        !/\\\r?\n$/.test(text.slice(0, match.index)),
    )
    .map((match) => ({
      file: match[1] ?? match[2],
      quoted: match[1] !== undefined,
      start: match.index,
      end: match.index + match[0].length,
    }));
}
/** Locate a unique complete header guard, including guards nested in other blocks.
 * Shared with the header editor; comments, literals and macro continuations are protected.
 */
export function headerSpan(source, guard, { allowMissing = false } = {}) {
  if (typeof guard !== "string" || !/^[A-Za-z_]\w*$/.test(guard))
    throw new Error("Invalid header guard");
  const parts = [];
  let cursor = 0;
  for (const token of cppTokens(source)) {
    if (/^[A-Za-z_]\w*$/.test(token.text)) continue;
    parts.push(source.slice(cursor, token.start), token.text.replace(/[^\n]/g, " "));
    cursor = token.end;
  }
  parts.push(source.slice(cursor));
  const masked = parts.join("");
  const directives = [];
  // Consume complete logical directives, so continued macro bodies are not directives.
  for (const line of masked.matchAll(/^[ \t]*#[^\n]*(?:\n|$)/gm)) {
    if (directives.length && line.index < directives.at(-1).end) continue;
    let end = line.index + line[0].length;
    while (/\\\r?\n$/.test(masked.slice(line.index, end))) {
      const newline = masked.indexOf("\n", end);
      end = newline < 0 ? masked.length : newline + 1;
      if (newline < 0) break;
    }
    const kind = /^\s*#\s*(\w+)\b/.exec(line[0])?.[1];
    directives.push({ kind, start: line.index, end, text: masked.slice(line.index, end) });
  }
  const starts = directives.filter((item) =>
    new RegExp(`^\\s*#\\s*ifndef\\s+${guard}\\s*$`).test(item.text),
  );
  if (!starts.length && allowMissing) return undefined;
  if (starts.length !== 1) throw new Error("Missing or ambiguous header guard");
  const start = starts[0];
  let depth = 0;
  for (const item of directives.filter((item) => item.start >= start.start)) {
    if (["if", "ifdef", "ifndef"].includes(item.kind)) depth++;
    if (item.kind === "endif" && --depth === 0) return { start: start.start, end: item.end };
  }
  throw new Error("Incomplete header guard");
}
