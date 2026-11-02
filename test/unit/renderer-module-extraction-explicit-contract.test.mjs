import assert from "node:assert/strict";
import test from "node:test";
import { explicitFileContract } from "../../src/suites/explicit-edit-multi-agent/extraction/explicit-contract.mjs";

function task(preamble, content) {
  return {
    kind: "implementation",
    file: "example.cpp",
    preamble,
    postamble: "",
    fragments: [],
    using: [],
    replacement: "",
    destination: preamble + content,
  };
}

test("explicit file contract inventories ordered preamble and conditional membership without bodies", async () => {
  const input = task("#include <vector>\n", "#if ENABLED\nint f(){ return 28731; }\n#endif\n");
  const contract = await explicitFileContract(input);
  const text = JSON.stringify(contract);
  assert.match(text, /vector/);
  assert.match(text, /ENABLED/);
  assert.match(text, /int f/);
  assert.doesNotMatch(text, /28731|return/);
});

test("explicit file contract refuses includes outside the ordinary preamble", async () => {
  await assert.rejects(explicitFileContract(task("", '#include "later.h"\n')));
});

test("explicit file contract requires selected anchors for ambiguous ownership", async () => {
  const input = task("", "int f();\n");
  input.fragments = [
    { id: "fragment-1", beforeFragment: "private-neighbour", text: "int f();", scope: "" },
  ];
  await assert.rejects(explicitFileContract(input));
  await assert.doesNotReject(
    explicitFileContract(input, { anchoredFragments: new Set(["fragment-1"]) }),
  );
});

test("explicit file contract permits imports deduplicated by the reference", async () => {
  const input = task("", "int f();\n");
  input.using = [
    { scope: "a", text: "using std::x;" },
    { scope: "a", text: "using std::x;" },
  ];
  await assert.doesNotReject(explicitFileContract(input));
});

test("explicit file contract refuses unsupported preamble directives", async () => {
  await assert.rejects(explicitFileContract(task("#pragma pack(1)\n", "int f(){return 1;}\n")));
});
