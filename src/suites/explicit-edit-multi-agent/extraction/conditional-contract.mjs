import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { symbolSpecifications } from "./symbol-spec.mjs";

const require = createRequire(import.meta.url);
let language;
async function cppLanguage() {
  language ??= (async () => {
    await Parser.init();
    return Language.load(require.resolve("tree-sitter-cpp/tree-sitter-cpp.wasm"));
  })();
  return language;
}
const conditions = new Set(["preproc_if", "preproc_ifdef"]);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function stripComments(source) {
  for (const token of cppTokens(source).reverse()) {
    if (token.text.startsWith("//") || token.text.startsWith("/*"))
      source = source.slice(0, token.start) + " " + source.slice(token.end);
  }
  return source;
}

function directiveHead(source, start) {
  let end = start;
  do {
    const newline = source.indexOf("\n", end);
    end = newline < 0 ? source.length : newline + 1;
  } while (end < source.length && /\\\r?\n$/.test(source.slice(start, end)));
  return stripComments(source.slice(start, end))
    .replace(/\\\r?\n/g, " ")
    .trim();
}

function aggregate(items) {
  const values = new Map();
  for (const item of items) {
    const key = JSON.stringify(item);
    const previous = values.get(key);
    if (previous) previous.count++;
    else values.set(key, { ...item, count: 1 });
  }
  return [...values.values()].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
}

/** Describe conditional membership as inventories, without providing source bodies. */
export function conditionalContractsProse(blocks) {
  assert.ok(Array.isArray(blocks));
  if (!blocks.length) return "No top-level conditional blocks are required in this destination.";
  function describe(block, depth) {
    const scope = block.scope ? `namespace ${block.scope}` : "the global namespace";
    const lines = [
      `${"  ".repeat(depth)}In ${scope}, require ${block.count} occurrence(s) of this conditional block:`,
    ];
    for (const branch of block.branches) {
      lines.push(`${"  ".repeat(depth + 1)}Branch ${branch.head}:`);
      if (!branch.entities.length && !branch.blocks.length)
        lines.push(`${"  ".repeat(depth + 2)}No identified entities.`);
      for (const { scope: entityScope, kind, signature, count } of branch.entities) {
        const where = entityScope ? `namespace ${entityScope}` : "the global namespace";
        lines.push(
          `${"  ".repeat(depth + 2)}In ${where}, require ${count} ${kind.replaceAll("-", " ")} occurrence(s): ${signature}`,
        );
      }
      for (const nested of branch.blocks) lines.push(...describe(nested, depth + 2));
    }
    return lines;
  }
  return [
    "These inventories describe separate conditional blocks and branch membership, not source locations or an ordering of independent definitions. Preserve each directive and its original payload from the source; do not invent macro replacements.",
    ...blocks.flatMap((block) => describe(block, 0)),
  ].join("\n");
}

/** Public conditional group identities, without source offsets, bodies or definition order.
 * This describes conditional membership only; include ordering and other preprocessing
 * barriers require separate contract information. Unsupported syntax fails closed.
 */
export async function conditionalBlockContracts(
  task,
  { anchoredMacros = new Set(), disambiguated = new Set() } = {},
) {
  assert.equal(typeof task.destination, "string");
  assert.notEqual(task.kind, "vendor-header", "Vendor syntax requires separate identity handling");
  const cpp = await cppLanguage();
  const parser = new Parser();
  parser.setLanguage(cpp);
  const tree = parser.parse(task.destination);
  const payloads = new Map();
  const source = task.destination;

  async function identify(node, scope) {
    const fragment = source.slice(node.startIndex, node.endIndex);
    const standaloneType = [
      "class_specifier",
      "struct_specifier",
      "union_specifier",
      "enum_specifier",
    ].includes(node.type);
    const [entity, ...extra] = await symbolSpecifications({
      fragments: [
        {
          text:
            fragment + (standaloneType ? ";" : "") + (node.type.startsWith("preproc_") ? "\n" : ""),
          kind: node.type === "declaration" ? "declaration" : "unit",
          scope,
        },
      ],
    });
    assert.ok(entity && !extra.length, "Conditional entity is not uniquely identifiable");
    if (entity.kind === "include" || entity.kind === "macro")
      entity.signature = stripComments(entity.signature).trim();
    return { entity, fragment };
  }

  async function leaf(node, scope, path) {
    const { entity, fragment } = await identify(node, scope);
    const key = JSON.stringify([path, entity]);
    const prior = payloads.get(key);
    assert.ok(
      prior === undefined ||
        prior === fragment ||
        (entity.kind === "macro" && anchoredMacros.has(entity.signature)) ||
        disambiguated.has(
          JSON.stringify([entity.scope, entity.kind, entity.signature, entity.members ?? []]),
        ),
      "Ambiguous conditional entity payload",
    );
    payloads.set(key, fragment);
    return entity;
  }

  async function walk(nodes, scope, path, inside) {
    const entities = [],
      blocks = [];
    for (const node of nodes) {
      assert.ok(!node.isMissing && node.type !== "ERROR", "Unsupported or incomplete syntax");
      if (node.type === "comment") continue;
      if (node.type === "namespace_definition") {
        const name = node.childForFieldName("name"),
          body = node.childForFieldName("body");
        assert.ok(name && body && /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(name.text));
        const nested = await walk(
          body.namedChildren,
          scope ? `${scope}::${name.text}` : name.text,
          path,
          inside,
        );
        entities.push(...nested.entities);
        blocks.push(...nested.blocks);
      } else if (conditions.has(node.type)) {
        blocks.push(await block(node, scope, path));
      } else if (inside) {
        entities.push(await leaf(node, scope, path));
      } else if (node.hasError) {
        await identify(node, scope);
      }
    }
    return { entities, blocks };
  }

  async function block(node, scope, path) {
    assert.ok(
      node.children.some((child) => child.type === "#endif" && !child.isMissing),
      "Incomplete conditional syntax",
    );
    const branches = [];
    let current = node;
    while (current) {
      assert.ok(
        ["preproc_if", "preproc_ifdef", "preproc_elif", "preproc_else"].includes(current.type),
      );
      const head = directiveHead(source, current.startIndex);
      assert.match(head, /^#\s*(?:if|ifdef|ifndef|elif|else)\b/);
      const alternative = current.childForFieldName("alternative");
      const condition = current.childForFieldName("condition") ?? current.childForFieldName("name");
      assert.ok(
        current.type === "preproc_else" ||
          (condition && !condition.hasError && !condition.isMissing),
        "Unsupported condition",
      );
      const ignored = new Set([
        alternative?.id,
        current.childForFieldName("name")?.id,
        current.childForFieldName("condition")?.id,
      ]);
      const nested = await walk(
        current.namedChildren.filter((child) => !ignored.has(child.id)),
        scope,
        [...path, head],
        true,
      );
      branches.push({
        head,
        entities: aggregate(nested.entities),
        blocks: aggregate(nested.blocks),
      });
      current = alternative;
    }
    return { scope, branches };
  }

  try {
    const result = await walk(tree.rootNode.namedChildren, "", [], false);
    return aggregate(result.blocks);
  } finally {
    tree.delete();
    parser.delete();
  }
}
