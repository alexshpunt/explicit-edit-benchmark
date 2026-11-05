import assert from "node:assert/strict";
import test from "node:test";
import { prepareFragmentStructure } from "../../src/suites/explicit-edit-multi-agent/extraction/fragment-structure.mjs";

function fixture() {
  const a = "int a(){return 1;}";
  const b = "int b(){return 2;}";
  const keep = "int main(){return 0;}\n";
  const source = `${a}\n${b}\n${keep}`;
  return {
    initial: { "main.cpp": source },
    expected: { "main.cpp": keep, "a.cpp": `${a}\n${b}\n` },
    tasks: [
      {
        id: "t",
        file: "a.cpp",
        kind: "implementation",
        replacement: "",
        destination: `${a}\n${b}\n`,
        fragments: [
          { id: "a", start: 0, end: a.length, text: a },
          { id: "b", start: a.length + 1, end: a.length + 1 + b.length, text: b },
        ],
      },
    ],
  };
}

test("cancelled preparation and assessment do not return a scoreable result", async () => {
  const p = fixture(),
    controller = new AbortController();
  controller.abort(Error("cancelled"));
  await assert.rejects(prepareFragmentStructure(p, { signal: controller.signal }), /cancelled/);
  const assess = await prepareFragmentStructure(p);
  await assert.rejects(assess(p.expected, { signal: controller.signal }), /cancelled/);
});
test("complete reference has no failed fragments", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p),
    result = await assess(p.expected);
  assert.equal(result.totalFragments, 2);
  assert.deepEqual(result.differenceIds, []);
});

test("one absent move is one failed fragment and not a failed file", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    "main.cpp": `int b(){return 2;}\n${p.expected["main.cpp"]}`,
    "a.cpp": "int a(){return 1;}\n",
  });
  assert.equal(result.failedFragments, 1);
  assert.equal(result.differenceIds.length, 1);
  assert.deepEqual(result.preservationIds, []);
});

test("a copied fragment that remains in the source fails", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "main.cpp": `int a(){return 1;}\n${p.expected["main.cpp"]}`,
  });
  assert.equal(result.failedFragments, 1);
});

test("extra copies in source count as failed removal plus preservation damage", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "main.cpp": `int a(){return 1;}\nint a(){return 1;}\n${p.expected["main.cpp"]}`,
  });
  assert.equal(result.failedFragments, 1);
  assert.deepEqual(result.preservationIds, ["preservation:main.cpp"]);
});
test("identical copies use multiplicity without attributing an individual copy", async () => {
  const unit = "int repeated(){return 1;}";
  const keep = "int main(){return 0;}\n";
  const plan = {
    initial: { "main.cpp": `${unit}\n${unit}\n${keep}` },
    expected: { "main.cpp": keep, "a.cpp": `${unit}\n${unit}\n` },
    tasks: [
      {
        id: "t",
        file: "a.cpp",
        kind: "implementation",
        replacement: "",
        destination: `${unit}\n${unit}\n`,
        fragments: [
          { id: "a", start: 0, end: unit.length, text: unit },
          { id: "b", start: unit.length + 1, end: unit.length * 2 + 1, text: unit },
        ],
      },
    ],
  };
  const assess = await prepareFragmentStructure(plan);
  const one = await assess({ "main.cpp": `${unit}\n${keep}`, "a.cpp": `${unit}\n` });
  assert.equal(one.failedFragments, 1);
  assert.equal(one.differenceIds.filter((id) => id.startsWith("fragment:")).length, 1);
  const done = await assess(plan.expected);
  assert.equal(done.failedFragments, 0);
});

test("identical fragments sent to different files retain distinct final deficits", async () => {
  const unit = "int duplicate(){return 1;}",
    keep = "int main(){return 0;}\n";
  const plan = {
    initial: { "main.cpp": `${unit}\n${unit}\n${keep}` },
    expected: { "main.cpp": keep, "a.cpp": `${unit}\n`, "b.cpp": `${unit}\n` },
    tasks: [
      {
        id: "a",
        file: "a.cpp",
        kind: "implementation",
        replacement: "",
        destination: `${unit}\n`,
        fragments: [{ id: "one", start: 0, end: unit.length, text: unit }],
      },
      {
        id: "b",
        file: "b.cpp",
        kind: "implementation",
        replacement: "",
        destination: `${unit}\n`,
        fragments: [{ id: "two", start: unit.length + 1, end: unit.length * 2 + 1, text: unit }],
      },
    ],
  };
  const assess = await prepareFragmentStructure(plan);
  const first = await assess({ "main.cpp": keep, "a.cpp": "", "b.cpp": `${unit}\n` });
  const second = await assess({ "main.cpp": keep, "a.cpp": `${unit}\n`, "b.cpp": "" });
  assert.equal(first.failedFragments, 1);
  assert.equal(second.failedFragments, 1);
  assert.notDeepEqual(first.differenceIds, second.differenceIds);
  const retained = await assess({
    "main.cpp": `${unit}\n${keep}`,
    "a.cpp": `${unit}\n`,
    "b.cpp": "",
  });
  assert.equal(retained.failedFragments, 1);
  assert.deepEqual(retained.preservationIds, []);
});
test("a modified source residue is not mistaken for a successful removal", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "main.cpp": `int a(){return 9;}\n${p.expected["main.cpp"]}`,
  });
  assert.equal(result.failedFragments, 1);
  assert.deepEqual(result.preservationIds, []);
});
test("an unidentifiable source unit is charged as a preservation difference", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "main.cpp": `int unknown(){return 9;}\n${p.expected["main.cpp"]}`,
  });
  assert.equal(result.status, "fail");
  assert.equal(result.failedFragments, 0);
  assert.deepEqual(result.preservationIds, ["preservation:main.cpp"]);
  assert.ok(result.fileDifferenceIds.length > 0, "a failed snapshot always has repair targets");
});
test("a damaged residual source is a separate preservation difference", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({ ...p.expected, "main.cpp": "int main(){return 7;}\n" });
  assert.equal(result.failedFragments, 0);
  assert.deepEqual(result.preservationIds, ["preservation:main.cpp"]);
  assert.ok(result.fileDifferenceIds.length > 0, "a failed snapshot always has repair targets");
});

test("a renamed target fragment fails once without a separate preservation charge", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "a.cpp": "int unknown(){return 1;}\nint b(){return 2;}\n",
  });
  assert.equal(result.failedFragments, 1);
  assert.deepEqual(result.preservationIds, []);
});
test("a renamed target fragment and a stray empty statement are both charged", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "a.cpp": "int unknown(){return 1;}\nint b(){return 2;};\n",
  });
  assert.equal(result.failedFragments, 1);
  assert.deepEqual(result.preservationIds, ["preservation:a.cpp"]);
});
test("a destination that is not valid UTF-8 fails its fragments and preservation", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({ ...p.expected, "a.cpp": Buffer.from([0xff, 0xfe, 0x0a]) });
  assert.equal(result.failedFragments, 2);
  assert.deepEqual(result.preservationIds, ["preservation:a.cpp"]);
});
test("a missing function and an unrelated empty statement have separate penalties", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({ ...p.expected, "a.cpp": ";\nint b(){return 2;}\n" });
  assert.equal(result.failedFragments, 1);
  assert.deepEqual(result.preservationIds, ["preservation:a.cpp"]);
});

test("extra project files and include changes remain separate from fragment credit", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "a.cpp": `#include <vector>\n${p.expected["a.cpp"]}`,
    "other.cpp": "",
  });
  assert.equal(result.failedFragments, 0);
  assert.deepEqual(result.preservationIds, ["inventory:other.cpp", "preservation:a.cpp"]);
});
test("an altered function is a failed fragment, not an extra valid move", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "a.cpp": p.expected["a.cpp"].replace("return 1", "return 9"),
  });
  assert.equal(result.failedFragments, 1);
  assert.deepEqual(result.preservationIds, []);
});

test("unrelated extra target code receives a separate preservation penalty", async () => {
  const p = fixture(),
    assess = await prepareFragmentStructure(p);
  const result = await assess({
    ...p.expected,
    "a.cpp": `${p.expected["a.cpp"]}int unrelated(){return 3;}\n`,
  });
  assert.equal(result.failedFragments, 0);
  assert.deepEqual(result.preservationIds, ["preservation:a.cpp"]);
});
