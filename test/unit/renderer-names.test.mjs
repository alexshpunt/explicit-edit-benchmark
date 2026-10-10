import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  renameCategory,
  undoNames,
} from "../../src/suites/explicit-edit-multi-agent/generation/semantic-names.mjs";

const source = `#include <cstdio>
#include <utility>
#include <vector>
typedef int channel_word;
#define AS_CHANNEL(value) static_cast<channel_word>(value)
namespace yocto {
// Keep Item, width and measure in comments. Кириллица тоже остаётся.
struct Item { int width; int height = 0; Item(int width) : width(width) {} };
int size(const Item& item) { return item.width; }
template <typename Sequence> int count(const Sequence& seq) { return size(seq); }
template <typename T> auto adjust(T minimum);
template <typename T> auto adjust(T minimum) { struct Limits { T lower; }; return Limits{minimum}; }
template <typename T> constexpr auto span(T max);
template <typename T> constexpr auto span(T min, T max);
template <typename T> constexpr auto span(T max) { return span((T)0,max); }
template <typename T> constexpr auto span(T min, T max) { struct Bounds { T first, last; }; return Bounds{min,max}; }
int measure(Item item, int width) {
  extern int bias;
  auto dependent = [](const auto& value) { return value.height; };
  auto captured = [width, &item] { return width + item.width; };
  auto implicit = [&] { return width + item.width; };
  auto copied = [=] { return width + item.width; };
  const char* note = "Item width measure";
  auto pair = std::pair<int, int>{item.width, width};
  { int width = 3; item.width += width; }
  return pair.first + pair.second + item.width + (note[0] == 'I') + 0 * dependent(item) + 0 * captured() + 0 * implicit() + 0 * copied() + bias;
}
int measure(int width) { return width; }
int bias = 0;
}
namespace other { struct Item { int width; }; int measure(Item item) { return item.width; } }
static int vendor_add(int count) { return AS_CHANNEL(count); }
int main() { int width = 5; std::printf("%d\\n", yocto::measure(yocto::Item{4}, width) + 0 * yocto::count(std::vector<int>{1, 2}) + 0 * yocto::measure(3) + 0 * other::measure(other::Item{2}) + 0 * vendor_add(4) + 0 * yocto::adjust(2).lower + 0 * (int)yocto::adjust(2.0).lower + 0 * yocto::span(2).first + 0 * (int)yocto::span(2.0).last); }
`;

await test(
  "semantic naming keeps types, fields and shadowed local bindings distinct",
  { timeout: 180_000 },
  async () => {
    await mkdir(".tmp", { recursive: true });
    const temporary = await mkdtemp(path.resolve(".tmp/names-contract-"));
    try {
      const original = { "main.cpp": source };
      let current = original;
      const records = [];
      for (const category of ["functions-types", "fields", "locals-parameters"]) {
        const result = await renameCategory(current, category, path.join(temporary, category));
        assert.ok(result.record.selection.length > 0);
        const selectedFamilies = new Set(result.record.selection.map((entry) => entry.family));
        for (const entry of result.record.selection) {
          if (!["local", "parameter"].includes(entry.role)) continue;
          assert.equal(entry.owner?.kind, "function");
          assert.ok(entry.owner?.scope);
          assert.ok(entry.owner?.signature);
          assert.doesNotMatch(entry.owner.signature, / at .*:\d+:\d+/);
        }
        for (const edit of result.record.edits) {
          assert.ok(edit.families?.length, "Every physical edit must retain its bound family");
          for (const family of edit.families) assert.ok(selectedFamilies.has(family));
        }
        const before = current["main.cpp"];
        for (const entry of result.record.selection) {
          const start = Buffer.from(before).subarray(0, entry.offset).toString("utf8").length;
          const edit = result.record.edits.find((item) => item.start === start);
          assert.ok(edit.families.includes(entry.family));
        }
        assert.match(result.tree["main.cpp"], /\/\/ Keep Item, width and measure in comments\./);
        assert.match(result.tree["main.cpp"], /"Item width measure"/);
        assert.match(result.tree["main.cpp"], /\.first/);
        assert.equal(result.record.vocabulary.version, "renderer-names-v1");
        assert.equal(JSON.stringify(result.record).includes(temporary), false);
        assert.equal(JSON.stringify(result.record).includes('"id":"0x'), false);
        current = result.tree;
        records.push(result.record);
        if (category === "functions-types") {
          assert.ok(result.record.excluded.some((entry) => entry.name === "size"));
          assert.ok(
            result.record.excluded.some(
              (entry) =>
                entry.name === "channel_word" && entry.reason === "macro-sensitive identifier",
            ),
          );
        }
      }
      assert.doesNotMatch(current["main.cpp"], /packed_(?:type|function|field|local)_/);
      const items = records[0].selection.filter((entry) => entry.name === "Item");
      assert.equal(new Set(items.map((entry) => entry.newName)).size, 2);
      const widths = records[2].selection.filter((entry) => entry.name === "width");
      assert.ok(new Set(widths.map((entry) => entry.newName)).size > 1);
      const measures = records[0].selection.filter((entry) => entry.name === "measure");
      assert.equal(
        new Set(measures.filter((entry) => entry.scope === "yocto").map((entry) => entry.newName))
          .size,
        1,
      );
      assert.ok(records[0].selection.some((entry) => entry.name === "vendor_add"));
      assert.match(current["main.cpp"], /int height = 0/);
      assert.ok(
        records[1].excluded.some(
          (entry) => entry.name === "height" && entry.reason === "dependent member reference",
        ),
      );
      await writeTree(path.join(temporary, "final"), current);
      const executable = path.join(temporary, "program");
      execFileSync("clang++", [
        "-std=c++17",
        path.join(temporary, "final", "main.cpp"),
        "-o",
        executable,
      ]);
      assert.equal(execFileSync(executable, [], { encoding: "utf8" }).trim(), "17");
      const repeat = await renameCategory(
        original,
        "functions-types",
        path.join(temporary, "repeat"),
      );
      assert.deepEqual(repeat.record, records[0]);
      assert.throws(
        () =>
          undoNames(
            { ...current, "main.cpp": current["main.cpp"] + "// changed\n" },
            records.at(-1),
          ),
        /identity/,
      );
      for (const record of records.reverse())
        current = undoNames(current, JSON.parse(JSON.stringify(record)));
      assert.deepEqual(current, original);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
