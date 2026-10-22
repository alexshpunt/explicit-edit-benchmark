import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { semanticSession } from "../../src/suites/explicit-edit-multi-agent/cpp/clangd-renames.mjs";

test("using-declaration wrappers do not duplicate the compiler's canonical template identity", async () => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/compiler-using-identity-"));
  const source = `#include <array>
namespace frond {
using std::array;
template<class T> void use(const array<T, 3>& value) {}
}
int main() {}
`;
  const file = path.join(directory, "main.cpp");
  await writeFile(file, source);
  let session;
  try {
    session = await semanticSession(file, source, ["-std=c++17"]);
    const symbols = await session.symbols({
      line: 3,
      character: source.split("\n")[3].indexOf("array"),
    });
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "array");
    assert.equal(symbols[0].containerName, "std::");
    assert.ok(symbols[0].usr);
  } finally {
    session?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("type and symbol inspection retain the same compiler document and canonical constructor identity", async () => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/compiler-introspection-"));
  const source = `const char* label = "💡";
namespace frond {
template<class T> struct Box {};
template<class T> using Alias = Box<T>;
template<class T> void first(const Box<T>& value) {}
template<class U> void second(const Box<U>& value) {}
void alias_use(Alias<int> value);
void old() {}
}
int main() { frond::old(); }
`;
  const file = path.join(directory, "main.cpp");
  await writeFile(file, source);
  let session;
  try {
    session = await semanticSession(file, source, ["-std=c++17"]);
    const selected = [
      {
        offset: Buffer.byteLength(source.slice(0, source.indexOf("old() {}"))),
        name: "old",
        newName: "renamed",
        family: "same-document",
      },
    ];
    const before = await session.edits(selected);
    const root = await session.ast();
    const types = [];
    function visit(node) {
      if (node.role === "type" && node.kind === "TemplateSpecialization" && node.range)
        types.push(node);
      for (const child of node.children ?? []) visit(child);
    }
    visit(root);
    const named = (node) => node.children?.find((child) => child.role === "template name")?.detail;
    const uses = types.filter((node) => named(node) === "Box" && node.range.start.line >= 4);
    assert.equal(uses.length, 2);
    const first = await session.symbols(uses[0].range.start);
    const second = await session.symbols(uses[1].range.start);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].name, "Box");
    assert.ok(first[0].usr);
    assert.equal(first[0].usr, second[0].usr);
    const alias = types.find((node) => named(node) === "Alias");
    assert.ok(alias);
    const symbols = await session.symbols(alias.range.start);
    assert.ok(symbols.some((symbol) => symbol.name === "Alias"));
    assert.ok(symbols.some((symbol) => symbol.usr === first[0].usr));
    const scoped = await session.ast(uses[0].range);
    assert.ok(scoped);
    assert.deepEqual(await session.edits(selected), before);
    assert.equal(before.length, 2);
    assert.ok(
      before.every((edit) => source.slice(edit.start, edit.start + edit.old.length) === "old"),
    );
  } finally {
    session?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
