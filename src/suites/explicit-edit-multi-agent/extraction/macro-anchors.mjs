import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { symbolSpecifications } from "./symbol-spec.mjs";

// Scan literal directives without interpreting macro replacements. All offsets
// are UTF-16 indices into this exact string, as in the extraction plan.
function definitions(source) {
  const lexical = source.split("");
  const uncommented = source.split("");
  const protectedTokens = [];
  for (const token of cppTokens(source)) {
    if (/^[A-Za-z_]\w*$/.test(token.text)) continue;
    const comment = token.text.startsWith("//") || token.text.startsWith("/*");
    assert.ok(
      !token.text.startsWith("//") || !/\\\r?$/.test(token.text),
      "Spliced line comment is unsupported",
    );
    protectedTokens.push(token);
    for (let i = token.start; i < token.end; i++) {
      if (source[i] === "\n" || source[i] === "\r") continue;
      lexical[i] = " ";
      if (comment) uncommented[i] = " ";
    }
  }
  const mask = lexical.join("");
  const plain = uncommented.join("");
  assert.ok(!/%:|\?\?=/.test(mask), "Alternate preprocessing token is unsupported");
  assert.ok(!/["']|\/\*|\/\//.test(mask), "Unsupported or incomplete C++ literal or comment");
  const result = [];
  for (let start = 0; start < source.length;) {
    let end = start;
    do {
      const newline = source.indexOf("\n", end);
      end = newline < 0 ? source.length : newline + 1;
    } while (end < source.length && /\\\r?\n$/.test(source.slice(start, end)));
    const lexicalLine = mask.slice(start, end).replace(/\\\r?\n/g, "");
    const head = /^[ \t]*#[ \t]*([A-Za-z_]\w*)\b/.exec(lexicalLine);
    if (head?.[1] === "define") {
      const hash = mask.indexOf("#", start);
      assert.ok(hash >= start && hash < end, "Missing macro directive marker");
      assert.ok(
        !protectedTokens.some((token) => token.start < end && end < token.end),
        "Multiline literal or comment in a macro is unsupported",
      );
      const raw = plain.slice(start, end).replace(/\\\r?\n/g, "");
      const match = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\([^()\r\n]*\))?/.exec(raw);
      assert.ok(match, "Unsupported macro definition");
      const params = match.slice(2, 3).join("");
      if (params)
        assert.match(
          params,
          /^\(\s*(?:(?:[A-Za-z_]\w*|\.\.\.)(?:\s*,\s*(?:[A-Za-z_]\w*|\.\.\.))*)?\s*\)$/,
          "Unsupported macro parameters",
        );
      result.push({ hash, start, end, signature: match[1] + params, payload: raw.trim() });
    }
    start = end;
  }
  return result;
}

function uniqueExcerpt(source, definition) {
  const lineStart = source.lastIndexOf("\n", definition.hash - 1) + 1;
  let end = definition.end;
  let start = lineStart;
  let radius = 1;
  for (;;) {
    const text = source.slice(start, end);
    if (source.indexOf(text) === source.lastIndexOf(text)) {
      const line = source.slice(0, definition.hash).split("\n").length;
      const contextLine = source.slice(0, start).split("\n").length;
      return {
        line,
        contextLine,
        text,
        offset: definition.hash - start,
        length: definition.end - definition.hash,
      };
    }
    assert.ok(start > 0 || end < source.length, "Macro source context is not unique");
    const before = Math.max(0, lineStart - radius);
    const after = Math.min(source.length, definition.end + radius);
    start = before ? source.lastIndexOf("\n", before - 1) + 1 : 0;
    const next = source.indexOf("\n", after);
    end = next < 0 ? source.length : next + 1;
    radius *= 2;
  }
}

/** Expose exact source context only for owned macros with competing payloads.
 * Preamble macros are copied; fragments are moved. A caller must revalidate all
 * locations and context after taking the shared-source lock.
 */
export async function macroAmbiguityAnchors(source, task) {
  assert.equal(typeof source, "string");
  assert.notEqual(task.kind, "vendor-header", "Vendor copies use a separate contract");
  assert.ok(Array.isArray(task.fragments));
  const all = definitions(source);
  const bySignature = new Map();
  for (const definition of all) {
    if (!bySignature.has(definition.signature)) bySignature.set(definition.signature, []);
    bySignature.get(definition.signature).push(definition);
  }
  const selected = new Map();
  for (const fragment of task.fragments) {
    if (!["conditional", "directive"].includes(fragment.kind)) continue;
    assert.ok(Number.isSafeInteger(fragment.start) && Number.isSafeInteger(fragment.end));
    assert.equal(source.slice(fragment.start, fragment.end), fragment.text, "Stale fragment");
    const specs = await symbolSpecifications(
      { fragments: [fragment], using: [] },
      { allowDuplicates: true },
    );
    const counts = new Map();
    for (const spec of specs.filter((entry) => entry.kind === "macro"))
      counts.set(spec.signature, (counts.get(spec.signature) ?? 0) + 1);
    for (const [signature, count] of counts) {
      const matches = (bySignature.get(signature) ?? []).filter(
        (item) => item.hash >= fragment.start && item.end <= fragment.end,
      );
      assert.equal(matches.length, count, "Macro ownership is not uniquely identifiable");
      for (const item of matches) selected.set(item.hash, { ...item, action: "move" });
    }
  }
  const prefix = definitions(task.preamble ?? "");
  for (const item of prefix) {
    const matches = (bySignature.get(item.signature) ?? []).filter(
      (candidate) => candidate.payload === item.payload,
    );
    assert.ok(matches.length, "Preamble macro cannot be found in the original source");
    if (!selected.has(matches[0].hash))
      selected.set(matches[0].hash, { ...matches[0], action: "copy" });
  }
  const result = [];
  for (const definition of selected.values()) {
    const candidates = bySignature.get(definition.signature);
    if (new Set(candidates.map((item) => item.payload)).size < 2) continue;
    result.push({
      signature: definition.signature,
      action: definition.action,
      ...uniqueExcerpt(source, definition),
    });
  }
  return result;
}

/** Present only the macro definitions which need source-level disambiguation. */
export function macroAmbiguityAnchorsProse(entries) {
  assert.ok(Array.isArray(entries));
  if (!entries.length) return "";
  return [
    "The following macros have competing source definitions. Their line numbers refer only to the original snapshot and may be stale. Under the shared workspace lock, re-read main.cpp and confirm that the exact context occurs once before acting. If it is missing or ambiguous, do not guess; report the ambiguity.",
    ...entries.map(({ signature, action, line, contextLine, text, offset, length: extent }) => {
      let length = 3;
      for (const [run] of text.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
      const fence = "`".repeat(length);
      const ending = text.endsWith("\r\n") ? "CRLF" : text.endsWith("\n") ? "LF" : "no line break";
      const digest = createHash("sha256").update(text).digest("hex");
      return `For ${signature}, ${action} the definition at snapshot line ${line}; its exact context begins at snapshot line ${contextLine}. Within that context, the directive begins ${offset} JavaScript UTF-16 code units from the start and has length ${extent} code units. The exact context has length ${text.length} JavaScript UTF-16 code units, ends with ${ending}, and has UTF-8 SHA-256 ${digest}. The code fence itself is not part of the context:\n${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
    }),
  ].join("\n\n");
}
