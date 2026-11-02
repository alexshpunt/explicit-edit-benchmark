import assert from "node:assert/strict";
import test from "node:test";
import {
  macroAmbiguityAnchors,
  macroAmbiguityAnchorsProse,
} from "../../src/suites/explicit-edit-multi-agent/extraction/macro-anchors.mjs";

function taskFor(source, fragment, preamble = "") {
  const start = source.indexOf(fragment);
  assert.notEqual(start, -1);
  return {
    kind: "header",
    preamble,
    fragments: [{ start, end: start + fragment.length, text: fragment, kind: "directive" }],
  };
}

test("a unique owned macro does not expose its source or position", async () => {
  const source = "#define OWNED private_payload\nint private_body;\n";
  assert.deepEqual(
    await macroAmbiguityAnchors(source, taskFor(source, "#define OWNED private_payload\n")),
    [],
  );
});

test("different replacement texts for one public macro require the owned exact source and line", async () => {
  const source = "#define FLAG 11\nint neighbour;\n#define FLAG 22\n";
  const anchors = await macroAmbiguityAnchors(source, taskFor(source, "#define FLAG 22\n"));
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].signature, "FLAG");
  assert.equal(anchors[0].line, 3);
  assert.match(anchors[0].text, /#define FLAG 22/);
  assert.doesNotMatch(anchors[0].text, /#define FLAG 11/);
  const prose = macroAmbiguityAnchorsProse(anchors);
  assert.match(prose, /snapshot line 3/);
  assert.match(prose, /#define FLAG 22/);
  assert.match(prose, /shared workspace lock/);
});

test("identical duplicate macro text gets unique nearby context when a competing payload exists", async () => {
  const source = "#define F 1\nint before_a;\n#define F 1\nint before_b;\n#define F 2\n";
  const fragment = "#define F 1\n";
  const start = source.indexOf(fragment, 1);
  const task = {
    kind: "header",
    preamble: "",
    fragments: [{ start, end: start + fragment.length, text: fragment, kind: "directive" }],
  };
  const anchors = await macroAmbiguityAnchors(source, task);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].line, 3);
  assert.equal(source.split(anchors[0].text).length, 2);
  assert.equal(
    anchors[0].text.slice(anchors[0].offset, anchors[0].offset + anchors[0].length),
    fragment,
  );
  assert.match(macroAmbiguityAnchorsProse(anchors), /JavaScript UTF-16 code units/);
});

test("copied preamble macros require anchors only when their public name is ambiguous", async () => {
  const source = "#define MODE 1\n#define MODE 2\n";
  const task = { kind: "implementation", preamble: "#define MODE 2\n", fragments: [] };
  const anchors = await macroAmbiguityAnchors(source, task);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].line, 2);
  assert.equal(anchors[0].action, "copy");
});

test("macro-looking text inside raw strings and comments cannot become anchors", async () => {
  const source =
    '#define MODE 1\nconst char *s = R"x(\n#define MODE 2\n)x";\n/*\n#define MODE 3\n*/\n';
  assert.deepEqual(await macroAmbiguityAnchors(source, taskFor(source, "#define MODE 1\n")), []);
});

test("conditional macro ownership is identified without exposing unrelated function bodies", async () => {
  const fragment = "#if A\n#define CHOICE 1\nint f(){ return 9841; }\n#endif\n";
  const source = `${fragment}#define CHOICE 2\n`;
  const task = {
    kind: "header",
    preamble: "",
    fragments: [{ start: 0, end: fragment.length, text: fragment, kind: "conditional", scope: "" }],
  };
  const anchors = await macroAmbiguityAnchors(source, task);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].line, 2);
  assert.doesNotMatch(anchors[0].text, /9841/);
});

test("a fragment with an unrelated same-name macro inside an opaque body fails closed", async () => {
  const fragment = "#if A\n#define CHOICE 1\nint f(){\n#define CHOICE 3\nreturn 7;\n}\n#endif\n";
  const source = `${fragment}#define CHOICE 2\n`;
  const task = {
    kind: "header",
    preamble: "",
    fragments: [{ start: 0, end: fragment.length, text: fragment, kind: "conditional", scope: "" }],
  };
  await assert.rejects(macroAmbiguityAnchors(source, task));
});

test("unsupported alternate directives and spliced comments fail closed", async () => {
  const source = "#define MODE 1\n%:define MODE 2\n";
  await assert.rejects(macroAmbiguityAnchors(source, taskFor(source, "#define MODE 1\n")));
  const spliced = "#define MODE 1\n// hidden\\\n#define MODE 2\n";
  await assert.rejects(macroAmbiguityAnchors(spliced, taskFor(spliced, "#define MODE 1\n")));
});
