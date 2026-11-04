import assert from "node:assert/strict";
import { cppTokens } from "../cpp/cpp-tokens.mjs";

// Compare preprocessing tokens rather than whitespace: Clang normalizes spacing
// in directives-only output. Quoted values and multi-character operators must
// remain intact, and unknown characters are rejected rather than ignored.
function tokens(line) {
  const pattern =
    /(?:u8|u|U|L)?"(?:\\.|[^"\\])*"|(?:u8|u|U|L)?'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|(?:\d|\.\d)(?:[eEpP][+-]|[A-Za-z_0-9.'])*|%:%:|>>=|<<=|<=>|->\*|\.\.\.|##|::|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|%=|\^=|&=|\|=|\.\*|<:|:>|<%|%>|%:|[{}[\]#();:?~!%^&*+\-/|<>=,.]/gy;
  const result = [];
  let offset = 0;
  while (offset < line.length) {
    if (/\s/.test(line[offset])) {
      offset++;
      continue;
    }
    pattern.lastIndex = offset;
    const match = pattern.exec(line);
    assert.ok(match, "Unsupported preprocessing token");
    result.push(match[0]);
    offset = pattern.lastIndex;
  }
  return result;
}

function functionMacro(line) {
  const macro = /^\s*#\s*define\s+([A-Za-z_]\w*)(\s*)\(/.exec(line);
  return macro ? [macro[1], macro[2].length === 0] : null;
}

/** Project a Clang directives-only CPU view onto exact lines in its input.
 * Returned offsets index the original JavaScript string. The caller must keep
 * the Clang command, source filename and compiler environment bound together.
 * Unsupported source formats and output markers reject rather than guess.
 */
export function projectActiveLines(source, output, filename) {
  assert.equal(typeof source, "string");
  assert.equal(typeof output, "string");
  assert.match(filename, /^[^"\\\r\n]+$/);
  assert.ok(!/\r|\\\n/.test(source), "Unsupported physical source layout");
  assert.ok(!/^\s*#\s*(?:line\b|\d)/m.test(source), "Source changes line mapping");
  for (const token of cppTokens(source)) {
    assert.ok(!/^(?:u8|u|U|L)?R"/.test(token.text), "Unsupported raw string");
    if (token.text.includes("\n") || token.text.startsWith("//") || token.text.startsWith("/*"))
      throw new Error("Unsupported multiline token or comment");
  }
  const lines = [];
  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (match[0])
      lines.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  const selected = [];
  let file = null,
    number = 0,
    last = 0,
    sawInput = false;
  for (const line of output.split("\n")) {
    if (/^#\s*\d/.test(line)) {
      const marker = /^#\s+(\d+) "([^"\\]*)"((?: [1-4])*)$/.exec(line);
      assert.ok(marker, "Unsupported Clang line marker");
      number = Number(marker[1]);
      assert.ok(Number.isSafeInteger(number) && number >= 1);
      file = marker[2];
      assert.ok(
        file === filename || file === "<built-in>" || file === "<command line>",
        "Unexpected included source",
      );
      sawInput ||= file === filename;
      continue;
    }
    if (file !== filename) {
      assert.equal(line.trim(), "", "Unexpected non-input output");
      continue;
    }
    if (line.trim()) {
      assert.ok(
        number >= 1 && number <= lines.length && number > last,
        "Invalid or repeated original line",
      );
      const original = lines[number - 1];
      let candidate = line;
      const suffix = " /* clang -E -fkeep-system-includes */";
      if (candidate.endsWith(suffix)) {
        assert.match(original.text, /^\s*#\s*include\b/);
        candidate = candidate.slice(0, -suffix.length);
        assert.equal(candidate.trim(), original.text.trim());
      }
      assert.deepEqual(functionMacro(candidate), functionMacro(original.text));
      assert.deepEqual(tokens(candidate), tokens(original.text));
      assert.ok(
        !/^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/.test(candidate),
        "Unresolved conditional",
      );
      selected.push(original);
      last = number;
    }
    number++;
  }
  assert.ok(sawInput, "Missing input line marker");
  return selected;
}
