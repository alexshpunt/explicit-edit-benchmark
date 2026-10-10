import { cppTokens } from "./cpp-tokens.mjs";

/** Normalize a current declaration header for an exact physical selector, not a name-wide edit. */
export function unitDeclarator(source, unit) {
  const text = source.slice(unit.start, unit.end);
  const protectedTokens = cppTokens(text).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  let result = "",
    position = 0,
    protectedIndex = 0;
  while (position < text.length) {
    const token = protectedTokens.at(protectedIndex);
    if (token?.start === position) {
      if (!token.text.startsWith("//") && !token.text.startsWith("/*")) result += token.text;
      position = token.end;
      protectedIndex++;
      continue;
    }
    if (unit.kind === "conditional" && text[position] === "#") {
      const newline = text.indexOf("\n", position);
      position = newline < 0 ? text.length : newline + 1;
      while (protectedTokens[protectedIndex]?.start < position) protectedIndex++;
      continue;
    }
    if (
      text[position] === "{" &&
      unit.kind === "conditional" &&
      /^namespace[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(result)
    ) {
      result += "{";
      position++;
      continue;
    }
    if (["{", ";"].includes(text[position])) break;
    if (!/\s/.test(text[position])) result += text[position];
    position++;
  }
  if (!result) throw new Error("Missing physical declaration header");
  return result;
}
/** Read physical namespace-level units, including inactive preprocessor branches.
 * Positions are UTF-16 offsets into this exact source. Literals and directives stay intact.
 * Layout selection may expose individual declarations inside namespace-level conditionals;
 * implementation extraction keeps those blocks whole. This is syntax, not binding resolution.
 */
export function cppStructure(source, { expandNamespaceConditionals = false } = {}) {
  const protectedTokens = cppTokens(source).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  const tokens = [];
  let position = 0,
    protectedIndex = 0;
  while (position < source.length) {
    const protectedToken = protectedTokens.at(protectedIndex);
    if (protectedToken?.start === position) {
      if (!protectedToken.text.startsWith("//") && !protectedToken.text.startsWith("/*"))
        tokens.push({ ...protectedToken, kind: "literal" });
      position = protectedToken.end;
      protectedIndex++;
      continue;
    }
    if (/\s/.test(source[position])) {
      position++;
      continue;
    }
    if (
      source[position] === "#" &&
      !source.slice(source.lastIndexOf("\n", position - 1) + 1, position).trim()
    ) {
      const start = position;
      do {
        const newline = source.indexOf("\n", position);
        position = newline < 0 ? source.length : newline + 1;
      } while (/\\\r?\n$/.test(source.slice(start, position)) && position < source.length);
      tokens.push({
        start,
        end: position,
        text: source.slice(start, position).trimEnd(),
        kind: "directive",
      });
      while (protectedTokens[protectedIndex]?.start < position) protectedIndex++;
      continue;
    }
    const word = /^[A-Za-z_]\w*|^\d+(?:[A-Za-z_0-9.]*)/.exec(source.slice(position));
    const text = word?.[0] ?? source[position];
    tokens.push({
      start: position,
      end: position + text.length,
      text,
      kind: word ? "word" : "punctuation",
    });
    position += text.length;
  }
  const units = [],
    namespaces = [],
    directives = [],
    usingByScope = new Map();
  const command = (token) => /^#\s*(\w+)/.exec(token.text)?.[1];
  function conditional(start) {
    let depth = 0;
    for (let index = start; index < tokens.length; index++) {
      if (tokens[index].kind !== "directive") continue;
      const kind = command(tokens[index]);
      if (["if", "ifdef", "ifndef"].includes(kind)) depth++;
      else if (kind === "endif" && --depth === 0) return index + 1;
    }
    throw new Error("Unclosed conditional source block");
  }
  function scope(start, names, using, close = false) {
    const scopeName = names.join("::");
    using = [...new Set([...using, ...(usingByScope.get(scopeName) ?? [])])];
    let index = start;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.text === "}") {
        if (!close) throw new Error("Unexpected namespace closing brace");
        return index + 1;
      }
      if (token.kind === "directive") {
        const kind = command(token);
        if (
          expandNamespaceConditionals &&
          names.length &&
          ["if", "ifdef", "ifndef", "else", "elif", "endif"].includes(kind)
        ) {
          directives.push({ ...token, scope: names.join("::") });
          index++;
          continue;
        }
        if (["if", "ifdef", "ifndef"].includes(kind)) {
          const end = conditional(index);
          units.push({
            start: token.start,
            end: tokens[end - 1].end,
            scope: names.join("::"),
            using: [...using],
            kind: "conditional",
            condition: token.text,
          });
          index = end;
        } else {
          if (["else", "elif", "endif"].includes(kind))
            throw new Error("Unmatched conditional directive");
          directives.push({ ...token, scope: names.join("::") });
          index++;
        }
        continue;
      }
      if (token.text === ";") {
        index++;
        continue;
      }
      let namespaceIndex = index;
      if (token.text === "inline" && tokens[index + 1]?.text === "namespace") namespaceIndex++;
      if (tokens[namespaceIndex]?.text === "namespace") {
        let opening = namespaceIndex + 1;
        while (opening < tokens.length && !["{", ";", "="].includes(tokens[opening].text))
          opening++;
        if (tokens[opening]?.text === "{") {
          const nameTokens = tokens.slice(namespaceIndex + 1, opening);
          const name = nameTokens.map((item) => item.text).join("");
          if (!name || !/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(name))
            throw new Error("Unsupported anonymous namespace ownership");
          const end = scope(opening + 1, [...names, ...name.split("::")], [...using], true);
          namespaces.push({
            start: token.start,
            end: tokens[end - 1].end,
            scope: [...names, name].join("::"),
          });
          index = end;
          if (tokens[index]?.text === ";") index++;
          continue;
        }
      }
      const begin = index;
      let round = 0,
        square = 0,
        braces = 0,
        sawBody = false,
        definition = false;
      for (; index < tokens.length; index++) {
        const item = tokens[index];
        if (item.kind === "directive") {
          if (["if", "ifdef", "ifndef"].includes(command(item))) {
            index = conditional(index) - 1;
            continue;
          }
          throw new Error("Directive interrupts a source unit");
        }
        if (item.kind === "literal") continue;
        if (item.text === "(") round++;
        if (item.text === ")") round--;
        if (item.text === "[") square++;
        if (item.text === "]") square--;
        if (item.text === "{") {
          if (!braces && !round && !square) sawBody = true;
          braces++;
        }
        if (item.text === "}") {
          braces--;
          if (braces < 0)
            throw new Error(
              `Incomplete namespace-level source unit near ${source.slice(tokens[begin].start, tokens[begin].start + 180)}`,
            );
          if (!braces && !round && !square && sawBody) {
            const prefix = tokens.slice(begin, index).findIndex((entry) => entry.text === "{");
            const header = tokens.slice(begin, begin + prefix);
            let nesting = 0;
            const declaration = header.some((entry) => {
              if (entry.text === "(") nesting++;
              if (entry.text === ")") nesting--;
              return (
                (!nesting && ["struct", "class", "enum", "union"].includes(entry.text)) ||
                (!nesting && entry.text === "=" && !header.some((item) => item.text === "operator"))
              );
            });
            definition = !declaration;
            if (!declaration) {
              index++;
              break;
            }
          }
        }
        if (round < 0 || square < 0) throw new Error("Unbalanced source declaration");
        if (item.text === ";" && !round && !square && !braces) {
          index++;
          break;
        }
      }
      if (index === begin || round || square || braces || index > tokens.length)
        throw new Error("Incomplete source unit");
      const end = tokens[index - 1]?.end;
      if (!end) throw new Error("Missing source unit boundary");
      const text = source.slice(tokens[begin].start, end);
      const isUsing =
        tokens[begin].text === "using" &&
        !tokens.slice(begin, index).some((item) => item.text === "=");
      if (isUsing) {
        using.push(text);
        usingByScope.set(scopeName, [...using]);
      }
      units.push({
        start: tokens[begin].start,
        end,
        scope: names.join("::"),
        using: [...using],
        kind: isUsing ? "using" : "declaration",
        definition,
      });
    }
    if (close) throw new Error("Unclosed namespace");
    return index;
  }
  scope(0, [], []);
  return { units, namespaces, directives };
}
