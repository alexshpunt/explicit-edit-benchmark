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
