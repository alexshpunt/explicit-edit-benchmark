import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ambiguityAnchors,
  locateAnchoredFragment,
  ambiguityAnchorsProse,
} from "../../src/suites/explicit-edit-multi-agent/extraction/ambiguity-anchors.mjs";

function fixture() {
  const repeated = "#ifdef ENABLED\n#define MARK 1\n#endif\n";
  const anchor = "int unique_target() { return 314159; }";
  const source = repeated + "int other();\n" + repeated + anchor + "\n";
  const start = source.lastIndexOf(repeated);
  return {
    source,
    task: {
      fragments: [
        {
          id: "duplicate",
          start,
          end: start + repeated.length,
          text: repeated,
          scope: "",
          kind: "conditional",
          beforeFragment: "unique",
        },
        {
          id: "unique",
          start: source.indexOf(anchor),
          end: source.indexOf(anchor) + anchor.length,
          text: anchor,
          scope: "",
          kind: "declaration",
        },
      ],
    },
  };
}

test("ambiguous owned occurrence has a uniquely revalidated anchor and snapshot lines", async () => {
  const { source, task } = fixture();
  const [entry] = await ambiguityAnchors(source, task);
  assert.equal(entry.startLine, 5);
  assert.equal(entry.endLine, 7);
  assert.equal(entry.target, task.fragments[0].text);
  assert.doesNotMatch(JSON.stringify(entry), /314159|return/);
  assert.equal(locateAnchoredFragment(source, entry), task.fragments[0].start);
  const updated = "// added by a peer\n" + source;
  assert.equal(
    locateAnchoredFragment(updated, entry),
    task.fragments[0].start + "// added by a peer\n".length,
  );
  assert.ok(ambiguityAnchorsProse([entry]).includes("unique_target"));
});

test("the exact target boundary is independently identifiable from the assignment", async () => {
  const { source, task } = fixture();
  const [entry] = await ambiguityAnchors(source, task);
  assert.ok(entry.target.endsWith("\n"));
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const prose = ambiguityAnchorsProse([entry]);
  assert.ok(prose.includes(digest(entry.target)));
  assert.ok(prose.includes(digest(entry.anchor)));
  assert.notEqual(digest(entry.target), digest(entry.target.slice(0, -1)));
});
test("an anchor before the target validates the target on its other side", async () => {
  const anchor = "int unique_before() { return 1234; }";
  const repeated = "#ifdef FLAG\n#define ITEM 1\n#endif\n";
  const source = anchor + "\n" + repeated + "int other();\n" + repeated;
  const start = source.indexOf(repeated);
  const task = {
    fragments: [
      { id: "anchor", start: 0, end: anchor.length, text: anchor, scope: "", kind: "declaration" },
      {
        id: "target",
        start,
        end: start + repeated.length,
        text: repeated,
        scope: "",
        kind: "conditional",
        afterFragment: "anchor",
      },
    ],
  };
  const [entry] = await ambiguityAnchors(source, task);
  assert.equal(entry.targetSide, "after");
  assert.equal(locateAnchoredFragment(source, entry), start);
  assert.throws(() =>
    locateAnchoredFragment(source.replace("int other();", "int changed();"), entry),
  );
});

test("duplicate neighbours can use an exact unique surrounding context", async () => {
  const repeated = "#define X 1\n";
  const neighbour = "int same();\n";
  const source = repeated + neighbour + "int peer;\n" + repeated + neighbour;
  const targetStart = source.lastIndexOf(repeated);
  const neighbourStart = source.lastIndexOf(neighbour);
  const task = {
    fragments: [
      {
        id: "target",
        start: targetStart,
        end: targetStart + repeated.length,
        text: repeated,
        scope: "",
        kind: "directive",
        beforeFragment: "neighbour",
      },
      {
        id: "neighbour",
        start: neighbourStart,
        end: neighbourStart + neighbour.length,
        text: neighbour,
        scope: "",
        kind: "declaration",
      },
    ],
  };
  const [anchor] = await ambiguityAnchors(source, task);
  assert.equal(locateAnchoredFragment(source, anchor), targetStart);
  assert.match(ambiguityAnchorsProse([anchor]), /snapshot lines/);
});

test("unambiguous entities produce no anchor data", async () => {
  const { source, task } = fixture();
  assert.deepEqual(await ambiguityAnchors(source, { fragments: [task.fragments[1]] }), []);
});

test("missing, changed, or duplicated anchor fails closed", async () => {
  const { source, task } = fixture();
  const [entry] = await ambiguityAnchors(source, task);
  assert.throws(() =>
    locateAnchoredFragment(source.replace("unique_target", "changed_target"), entry),
  );
  assert.throws(() => locateAnchoredFragment(source + "int unique_target();\n", entry));
  const invalid = { fragments: [{ ...task.fragments[0], beforeFragment: "missing" }] };
  await assert.rejects(ambiguityAnchors(source, invalid));
  await assert.rejects(ambiguityAnchors(source.replace("unique_target", "changed"), task));
});

test("nearest-match requirement rejects an anchor obscured by another matching target", async () => {
  const { source, task } = fixture();
  const [entry] = await ambiguityAnchors(source, task);
  const moved = source.replace(entry.anchor, entry.target + entry.anchor);
  assert.throws(() => locateAnchoredFragment(moved, entry));
});
