import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cppTokens, includeDirectives } from "../cpp/cpp-tokens.mjs";

function syntax(source) {
  const result = [];
  let cursor = 0;
  const gap = (end) => {
    for (const match of source.slice(cursor, end).matchAll(/\S/g))
      result.push({ text: match[0], start: cursor + match.index, end: cursor + match.index + 1 });
  };
  for (const token of cppTokens(source)) {
    gap(token.start);
    result.push(token);
    cursor = token.end;
  }
  gap(source.length);
  return result;
}

function close(tokens, start, opening, closing) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].text === opening) depth++;
    if (tokens[i].text === closing && --depth === 0) return i;
  }
  throw new Error("Incomplete function boundary");
}

function voidFunctions(source, name) {
  const tokens = syntax(source);
  const units = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].text !== "void" || tokens[i + 1].text !== name || tokens[i + 2].text !== "(")
      continue;
    const afterParameters = close(tokens, i + 2, "(", ")") + 1;
    const definition = tokens[afterParameters]?.text === "{";
    const end = definition ? close(tokens, afterParameters, "{", "}") : afterParameters;
    if (!definition && tokens[end]?.text !== ";") throw new Error("Unsupported function syntax");
    units.push({ start: tokens[i].start, end: tokens[end].end, definition });
    i = end;
  }
  return units;
}

function edit(source, replacements) {
  let result = "",
    cursor = 0;
  for (const item of replacements.sort((a, b) => a.start - b.start)) {
    if (item.start < cursor) throw new Error("Overlapping edits");
    result += source.slice(cursor, item.start) + item.text;
    cursor = item.end;
  }
  return result + source.slice(cursor);
}

function rename(source, mapping) {
  return edit(
    source,
    cppTokens(source)
      .filter((token) => mapping.has(token.text))
      .map((token) => ({ ...token, text: mapping.get(token.text) })),
  );
}

function headerSpan(source, guard) {
  let masked = source;
  const protectedTokens = cppTokens(source).filter((token) => !/^[A-Za-z_]\w*$/.test(token.text));
  masked = edit(
    masked,
    protectedTokens.map((token) => ({ ...token, text: token.text.replace(/[^\n]/g, " ") })),
  );
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
  if (starts.length !== 1) throw new Error("Missing or ambiguous header guard");
  const start = starts[0];
  let depth = 0;
  for (const item of directives.filter((item) => item.start >= start.start)) {
    if (["if", "ifdef", "ifndef"].includes(item.kind)) depth++;
    if (item.kind === "endif" && --depth === 0) return { start: start.start, end: item.end };
  }
  throw new Error("Incomplete header guard");
}

function restoreProjectIncludes(source, required) {
  if (
    !Array.isArray(required) ||
    required.some((file) => typeof file !== "string" || !/^[\w.-]+\.h$/.test(file)) ||
    new Set(required).size !== required.length
  )
    throw new Error("Invalid direct project include requirements");
  const sites = includeDirectives(source);
  const changes = [];
  for (const [index, file] of required.entries()) {
    if (sites.some((site) => site.quoted && site.file === file)) continue;
    const next = sites.find((site) => site.quoted && required.slice(index + 1).includes(site.file));
    const start =
      next?.start ??
      sites.at(-1)?.end ??
      /^\s*#\s*ifndef[^\n]*\n\s*#\s*define[^\n]*(?:\n|$)/.exec(source)?.[0].length;
    if (start === undefined) throw new Error("Missing header include anchor");
    changes.push({ start, end: start, text: `#include "${file}"\n` });
  }
  return edit(source, changes);
}
function appendNamespace(source, block, namespace, includes) {
  if (!source) return `${includes}\n\nnamespace ${namespace}\n{\nusing std::vector;\n${block}\n}\n`;
  const end = source.lastIndexOf("}");
  if (end < 0 || source.slice(end + 1).trim()) throw new Error("Unsupported module boundary");
  return source.slice(0, end) + "\n" + block + "\n" + source.slice(end);
}

/** Apply one public request through ordinary source edits, using no generator records or answers.
 * This is a pinned happy-path script, not an English interpreter or general C++ refactorer.
 * Slice local edits stay within the requested void overload. Full naming requests use
 * explicitly listed unique generated spellings, or a named translation-unit helper file.
 * Literals are protected in both modes; ambiguous requests must not be prepared.
 */
export function applyRequest(input, prompt) {
  const tree = { ...input };
  let match;
  if (
    (match =
      /^Restore the following binding names (throughout the project|in file `([^`]+)`)\.\n/.exec(
        prompt,
      ))
  ) {
    const block = /\nMappings:\n([\s\S]+?)\nEnd mappings\.\n/.exec(prompt);
    if (!block) throw new Error("Missing binding name mappings");
    const mapping = new Map();
    for (const line of block[1].split("\n")) {
      const pair = /^([A-Za-z_]\w*) -> ([A-Za-z_]\w*)$/.exec(line);
      if (!pair || mapping.has(pair[1]) || pair[1] === pair[2])
        throw new Error("Invalid binding name mappings");
      mapping.set(pair[1], pair[2]);
    }
    const file = match[2];
    if (file && tree[file] === undefined) throw new Error("Missing binding owner file");
    const found = new Set();
    for (const [name, source] of Object.entries(tree)) {
      if (file && name !== file) continue;
      for (const token of cppTokens(source)) if (mapping.has(token.text)) found.add(token.text);
      tree[name] = rename(source, mapping);
    }
    if ([...mapping.keys()].some((name) => !found.has(name)))
      throw new Error("Missing requested binding target");
    return tree;
  }
  if (
    (match =
      /^Move the complete (?:common math|project) header block guarded by `?([A-Za-z_]\w*)`? from `main\.cpp` into `([\w.-]+\.h)`/.exec(
        prompt,
      ))
  ) {
    const [, guard, target] = match;
    if (tree[target] !== undefined) throw new Error("Math header already exists");
    const span = headerSpan(tree["main.cpp"], guard);
    tree[target] = tree["main.cpp"].slice(span.start, span.end);
    if (prompt.startsWith("Move the complete project header")) {
      const required = /\nDirect project includes: ([^\n]+)\n/.exec(prompt);
      if (!required) throw new Error("Missing direct project include requirements");
      tree[target] = restoreProjectIncludes(tree[target], JSON.parse(required[1])).trimEnd();
    }
    tree["main.cpp"] = edit(tree["main.cpp"], [{ ...span, text: `#include "${target}"\n` }]);
  } else if (
    (match =
      /^Move the public void overload declaration of (\w+)::(\w+) .*? from main\.cpp to ([\w.-]+\.h)\./.exec(
        prompt,
      ))
  ) {
    const [, namespace, name, target] = match;
    const declarations = voidFunctions(tree["main.cpp"], name).filter((unit) => !unit.definition);
    if (!declarations.length) throw new Error("Missing public declaration");
    const span = declarations[0];
    const declaration = tree["main.cpp"].slice(span.start, span.end);
    const existing = tree[target];
    tree[target] = appendNamespace(
      existing,
      declaration,
      namespace,
      `#pragma once\n#include "${namespace}_math.h"\n#include <vector>`,
    );
    tree["main.cpp"] = edit(tree["main.cpp"], [
      { ...span, text: existing ? "" : `}\n#include "${target}"\nnamespace ${namespace}\n{` },
    ]);
  } else if (
    (match =
      /^Move the complete void definition of (\w+)::(\w+) .*? from main\.cpp into ([\w.-]+\.cpp)\./.exec(
        prompt,
      ))
  ) {
    const [, namespace, name, target] = match;
    const definitions = voidFunctions(tree["main.cpp"], name).filter((unit) => unit.definition);
    if (definitions.length !== 1) throw new Error("Missing or ambiguous definition");
    const span = definitions[0];
    const body = tree["main.cpp"].slice(span.start, span.end);
    tree[target] = appendNamespace(
      tree[target],
      body,
      namespace,
      `#include "${target.replace(/\.cpp$/, ".h")}"`,
    );
    tree["main.cpp"] = edit(tree["main.cpp"], [{ ...span, text: "" }]);
  } else if (
    (match = /^In the void overload of (\w+)::(\w+), restore .*?: ([\s\S]+?)\. Do not rename/.exec(
      prompt,
    ))
  ) {
    const mapping = new Map();
    for (const pair of match[3].split("; ")) {
      const parsed = /^(\w+) -> (\w+)$/.exec(pair);
      if (!parsed || (mapping.has(parsed[1]) && mapping.get(parsed[1]) !== parsed[2]))
        throw new Error("Invalid variable mapping");
      mapping.set(parsed[1], parsed[2]);
    }
    const seen = new Set();
    for (const [file, source] of Object.entries(tree)) {
      const units = voidFunctions(source, match[2]);
      tree[file] = edit(
        source,
        units.map((span) => {
          const block = source.slice(span.start, span.end);
          for (const token of cppTokens(block)) if (mapping.has(token.text)) seen.add(token.text);
          return { ...span, text: rename(block, mapping) };
        }),
      );
    }
    if ([...mapping.keys()].some((name) => !seen.has(name)))
      throw new Error("Missing variable target");
  } else {
    const global =
      /^Restore the whole overload family \w+::(\w+) to (\w+)\./.exec(prompt) ??
      /^Restore type \w+::(\w+) to (\w+),/.exec(prompt) ??
      /^Restore field \w+::(\w+) to (\w+),/.exec(prompt);
    if (!global) throw new Error("Unsupported request");
    const mapping = new Map([[global[1], global[2]]]);
    if (
      !Object.values(tree).some((source) =>
        cppTokens(source).some((token) => token.text === global[1]),
      )
    )
      throw new Error("Missing rename target");
    for (const [file, source] of Object.entries(tree)) tree[file] = rename(source, mapping);
  }
  return tree;
}

async function main() {
  if (process.argv.length !== 3)
    throw new Error("Usage: node scripted-worker.mjs WORKSPACE < CURRENT_REQUEST");
  const directory = path.resolve(process.argv[2]);
  const tree = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/\.(cpp|h)$/.test(entry.name)) continue;
    if (!entry.isFile()) throw new Error("Only regular source files are supported");
    tree[entry.name] = await readFile(path.join(directory, entry.name), "utf8");
  }
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk.toString("utf8");
  const next = applyRequest(tree, prompt.trim());
  for (const [file, source] of Object.entries(next))
    if (source !== tree[file]) await writeFile(path.join(directory, file), source);
  console.log("APPLIED current request");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
