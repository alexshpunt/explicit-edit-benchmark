import assert from "node:assert/strict";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

// Return directive identities and barrier order only. Macro replacement text is
// checked privately but is never included in the returned inventory.
export function preambleContract(source, { anchoredMacros = new Set() } = {}) {
  assert.equal(typeof source, "string");
  const chars = source.split("");
  for (const token of cppTokens(source)) {
    if (!token.text.startsWith("//") && !token.text.startsWith("/*")) {
      assert.ok(!token.text.includes("\n"), "Multiline literal in preamble is unsupported");
      continue;
    }
    assert.ok(
      !token.text.startsWith("//") || !/\\\r?$/.test(token.text),
      "Unsupported spliced comment",
    );
    for (let i = token.start; i < token.end; i++)
      if (source[i] !== "\n" && source[i] !== "\r") chars[i] = " ";
  }
  const masked = chars.join("");
  const stack = [],
    items = [],
    payloads = new Map();
  for (let start = 0; start < masked.length;) {
    let end = start;
    do {
      const newline = masked.indexOf("\n", end);
      end = newline < 0 ? masked.length : newline + 1;
    } while (end < masked.length && /\\\r?\n$/.test(masked.slice(start, end)));
    const line = masked
      .slice(start, end)
      .replace(/\\\r?\n/g, "")
      .trim();
    start = end;
    if (!line) continue;
    const directive = /^#\s*([A-Za-z_]\w*)\b(.*)$/.exec(line);
    assert.ok(directive, "Unsupported non-directive in preamble");
    const [, kind, rest] = directive;
    const value = rest.trim();
    if (["if", "ifdef", "ifndef"].includes(kind)) {
      assert.ok(value && (kind === "if" || /^[A-Za-z_]\w*$/.test(value)), "Invalid conditional");
      const head = `#${kind} ${value}`;
      stack.push({ head, sawElse: false });
      items.push({ kind: "conditional", head });
    } else if (kind === "elif" || kind === "else") {
      const frame = stack.at(-1);
      assert.ok(
        frame && !frame.sawElse && (kind === "elif" ? value : !value),
        "Invalid conditional branch",
      );
      if (kind === "else") frame.sawElse = true;
      const head = kind === "elif" ? `#elif ${value}` : "#else";
      frame.head = head;
      items.push({ kind: "branch", head });
    } else if (kind === "endif") {
      assert.ok(!value && stack.length, "Invalid conditional end");
      stack.pop();
      items.push({ kind: "end-conditional" });
    } else if (kind === "include") {
      assert.match(value, /^(?:<[^<>\r\n]+>|"[^"\r\n]+")$/, "Unsupported include");
      items.push({ kind: "include", name: value });
    } else if (kind === "pragma") {
      assert.equal(value, "once", "Unsupported pragma");
      items.push({ kind: "pragma-once" });
    } else if (kind === "undef") {
      assert.match(value, /^[A-Za-z_]\w*$/, "Invalid undef");
      items.push({ kind: "undef", name: value });
    } else if (kind === "define") {
      const match = /^([A-Za-z_]\w*)(\([^()]*\))?(?=\s|$)([\s\S]*)$/.exec(value);
      assert.ok(match, "Unsupported macro signature");
      const parameters = match.slice(2, 3).join("");
      if (parameters)
        assert.match(
          parameters,
          /^\(\s*(?:(?:[A-Za-z_]\w*|\.\.\.)(?:\s*,\s*(?:[A-Za-z_]\w*|\.\.\.))*)?\s*\)$/,
          "Unsupported macro parameters",
        );
      const name = match[1] + parameters;
      const key = JSON.stringify([stack.map((frame) => frame.head), name]);
      const previous = payloads.get(key);
      assert.ok(
        previous === undefined || previous === value || anchoredMacros.has(name),
        "Ambiguous macro payload",
      );
      payloads.set(key, value);
      items.push({ kind: "macro", name });
    } else throw new Error("Unsupported preamble directive");
  }
  assert.equal(stack.length, 0, "Unclosed preamble conditional");
  return items;
}

export function preambleContractProse(items, { sorted = false } = {}) {
  assert.ok(Array.isArray(items));
  const describe = (item) => {
    switch (item.kind) {
      case "pragma-once": {
        return "a pragma-once directive";
      }
      case "include": {
        return `an include of ${item.name}`;
      }
      case "conditional": {
        return `the start of conditional ${item.head}`;
      }
      case "branch": {
        return `conditional branch ${item.head}`;
      }
      case "end-conditional": {
        return "the end of the innermost conditional";
      }
      case "macro": {
        return `the original definition of macro ${item.name}`;
      }
      case "undef": {
        return `an undefinition of macro ${item.name}`;
      }
      default: {
        throw new Error("Unsupported preamble inventory item");
      }
    }
  };
  if (!items.length) return "No preamble directives are required.";
  return [
    sorted
      ? "The destination requires these directives and their conditional nesting. Their peer order is not significant. Preserve original macro replacement text from the source; this inventory does not contain replacements:"
      : "The preamble requires the following directive barriers in order. Preserve original macro replacement text from the source; this inventory does not contain replacements:",
    ...items.map((item, index) => `${index + 1}. ${describe(item)}.`),
  ].join("\n");
}
