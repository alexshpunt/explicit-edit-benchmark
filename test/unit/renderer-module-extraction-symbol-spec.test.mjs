import assert from "node:assert/strict";
import test from "node:test";
import { symbolSpecifications } from "../../src/suites/explicit-edit-multi-agent/extraction/symbol-spec.mjs";

const fragment = (text, kind = "declaration", scope = "demo") => ({ text, kind, scope });

test("symbol inventory preserves exact signatures and using aliases without bodies or source order", async () => {
  const task = {
    fragments: [
      fragment("int sum(int x, int y = 2) { return x + y; }"),
      fragment("using Number = unsigned long;", "using"),
      fragment("struct Thing { int secret = 42; };"),
      fragment("int value = make_value();"),
    ],
    using: [{ scope: "demo", text: "using std::vector;" }],
  };
  const items = await symbolSpecifications(task);
  assert.deepEqual(
    items,
    await symbolSpecifications({ ...task, fragments: [...task.fragments].reverse() }),
  );
  assert.ok(
    items.some(
      (item) =>
        item.scope === "demo" &&
        item.kind === "function-definition" &&
        item.signature === "int sum(int x, int y = 2)",
    ),
  );
  assert.ok(
    items.some(
      (item) =>
        item.scope === "demo" &&
        item.kind === "using" &&
        item.signature === "using Number = unsigned long;",
    ),
  );
  assert.ok(
    items.some(
      (item) =>
        item.scope === "demo" && item.kind === "using" && item.signature === "using std::vector;",
    ),
  );
  assert.ok(
    items.some(
      (item) => item.scope === "demo" && item.kind === "struct" && item.signature === "Thing",
    ),
  );
  assert.ok(
    items.some(
      (item) => item.scope === "demo" && item.kind === "variable" && item.signature === "int value",
    ),
  );
  assert.doesNotMatch(JSON.stringify(items), /return x|secret|make_value/);
});

test("function body boundaries do not consume braces in defaults or strings", async () => {
  const task = {
    fragments: [
      fragment('int run(Thing t = Thing{1}, const char* s = "{") noexcept { return 7; }'),
    ],
  };
  const items = await symbolSpecifications(task);
  assert.equal(items[0].signature, 'int run(Thing t = Thing{1}, const char* s = "{") noexcept');
  assert.doesNotMatch(JSON.stringify(items), /return 7/);
});

test("braced default arguments retain exact declaration signatures", async () => {
  const signatures = [
    "Image make(int width, const Vec& color = {0, 0, 0, 1})",
    "Image make(int width, const Vec& a = {1, 2}, const Vec& b = {{3}, {4}})",
    "inline float sample(const Vec& wrap = {0, 0}) noexcept",
  ];
  const inventory = await symbolSpecifications({
    fragments: signatures.map((s) => fragment(`${s};`)),
  });
  assert.deepEqual(inventory.map((item) => item.signature).sort(), [...signatures].sort());
  assert.ok(inventory.every((item) => item.kind === "function-declaration"));
});

test("braced defaults on definitions and unicode strings never expose the body", async () => {
  const signature = 'int measure(const char* name = "é", const Vec& color = {1, 2}) noexcept';
  const items = await symbolSpecifications({
    fragments: [fragment(`${signature} { return private_body; }`)],
  });
  assert.equal(items[0].kind, "function-definition");
  assert.equal(items[0].signature, signature);
  assert.ok(!JSON.stringify(items).includes("private_body"));
});

test("invalid defaults and lambda bodies are not accepted as declaration signatures", async () => {
  await assert.rejects(symbolSpecifications({ fragments: [fragment("int f(int x = {1, );")] }));
  await assert.rejects(
    symbolSpecifications({ fragments: [fragment("int f(int x = {[] { return 4; }()});")] }),
  );
});

test("conditional branches inventory nested namespaces and macros without replacement bodies", async () => {
  const task = {
    fragments: [
      fragment(
        "#ifdef CUDA\n#define ADD(x) ((x) + 1)\nnamespace demo { int f() { return 3; } }\n#undef ADD\n#endif\n",
        "conditional",
        "",
      ),
    ],
  };
  const items = await symbolSpecifications(task);
  assert.ok(items.some((item) => item.kind === "macro" && item.signature === "ADD(x)"));
  assert.ok(items.some((item) => item.kind === "macro-undef" && item.signature === "ADD"));
  assert.ok(
    items.some(
      (item) =>
        item.scope === "demo" &&
        item.kind === "function-definition" &&
        item.signature === "int f()",
    ),
  );
  assert.doesNotMatch(JSON.stringify(items), /return 3|\(\(x\) \+ 1\)/);
});

test("unrecognized fragments and indistinguishable owned entities fail closed", async () => {
  await assert.rejects(symbolSpecifications({ fragments: [fragment("unparseable ???")] }));
  await assert.rejects(
    symbolSpecifications({ fragments: [fragment("int x;"), fragment("int x;")] }),
  );
});
