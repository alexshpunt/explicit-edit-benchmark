import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decodeSourceBytes,
  encodeSourceBytes,
} from "../../src/suites/explicit-edit-multi-agent/cpp/source-bytes.mjs";
import { canonicalCorrectionNodes } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";
import {
  captureCandidate,
  releaseCandidateWorkspace,
} from "../../src/suites/explicit-edit-multi-agent/execution/candidate-evidence.mjs";
import {
  canonicalizeCapturedCandidate,
  canonicalizeTrustedProject,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-candidate.mjs";
import {
  compareCanonicalDiff,
  prepareCanonicalDiff,
} from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";

async function corrections(t, start, expected, actual) {
  const root = await mkdtemp(path.join(os.tmpdir(), "physical-feedback-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  t.after(async () => {
    releaseCandidateWorkspace(workspace);
    await rm(root, { recursive: true, force: true });
  });
  for (const [file, text] of Object.entries(actual)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), text);
  }
  const captured = await captureCandidate(workspace, path.join(root, "capture"), {
    includeAllFiles: true,
  });
  const prepared = prepareCanonicalDiff(
    await canonicalizeTrustedProject(start),
    await canonicalizeTrustedProject(expected),
  );
  const comparison = compareCanonicalDiff(prepared, await canonicalizeCapturedCandidate(captured));
  const nodes = await canonicalCorrectionNodes(comparison, prepared.start, {
    actual: captured,
    expected,
  });
  assert.deepEqual(
    [...new Set(nodes.flatMap(({ differenceIds }) => differenceIds))].sort(),
    [...comparison.differenceIds].sort(),
  );
  // Check the complete physical project, including macro dependencies, rather
  // than assuming individually valid replacement snippets compose correctly.
  const projected = new Map(captured.contents);
  for (const { repair } of [...nodes].reverse()) {
    if (repair.action === "directory") continue;
    if (repair.action === "remove") projected.delete(repair.pathBytes);
    else if (repair.action === "bytes")
      projected.set(repair.pathBytes, Buffer.from(repair.afterBytes, "base64"));
    else if (repair.action === "create")
      projected.set(repair.pathBytes, encodeSourceBytes(repair.after));
    else {
      assert.equal(repair.action, "replace");
      const current = decodeSourceBytes(projected.get(repair.pathBytes));
      assert.equal(current.split(repair.before).length - 1, 1);
      projected.set(
        repair.pathBytes,
        encodeSourceBytes(current.replace(repair.before, repair.after)),
      );
    }
  }
  const tree = Object.fromEntries(
    [...projected].map(([file, bytes]) => [decodeSourceBytes(Buffer.from(file, "base64")), bytes]),
  );
  assert.deepEqual(
    compareCanonicalDiff(prepared, await canonicalizeTrustedProject(tree)).differenceIds,
    [],
  );
  return { root, nodes, comparison };
}

for (const [name, source] of [
  [
    "preprocessing line boundaries",
    "#ifndef VALUE_TYPE\ntypedef union { unsigned bits; float value; } Value;\n#endif\nint main() { Value value{}; return value.bits; }\n",
  ],
  [
    "callee definitions before their uses",
    "int z_helper() { return 3; }\nint a_user() { return z_helper(); }\nint main() { return a_user() != 3; }\n",
  ],
  ["CRLF and an absent final newline", "int helper(){return 0;}\r\nint main(){return helper();}"],
  [
    "compound operators and literal bytes",
    "#define ID(x) x\nint main() { const char *text = \"a >= b\"; return ID(2 >= 1) && text[0] == 'a' ? 0 : 1; }\n",
  ],
]) {
  test(`new source correction preserves ${name} as compilable physical C++`, async (t) => {
    const { root, nodes } = await corrections(t, {}, { "main.cpp": source }, {});
    assert.equal(nodes.length, 1);
    const repair = nodes[0].repair;
    assert.equal(repair.action, "create");
    assert.ok(nodes[0].prompt.includes(repair.after));
    const file = path.join(root, "corrected.cpp");
    await writeFile(file, repair.after);
    const build = spawnSync("/usr/bin/clang++", ["-std=c++17", "-fsyntax-only", file], {
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(build.error, undefined);
    assert.equal(build.status, 0, build.stderr);
    assert.equal(await readFile(file, "utf8"), source);
  });
}

test("physical capture keeps opaque contents and unsafe filename bytes lossless", async (t) => {
  const bytes = Buffer.from([0xff, 0, 96, 13, 10]);
  const code = "int main(){return 0;}\n";
  const { nodes } = await corrections(t, {}, { "blob.bin": bytes, "odd\nname.cpp": code }, {});
  const blob = nodes.find(({ repair }) => repair.path === "blob.bin").repair;
  const unsafe = nodes.find(({ repair }) => repair.path === null).repair;
  assert.deepEqual(Buffer.from(blob.afterBytes, "base64"), bytes);
  assert.deepEqual(Buffer.from(unsafe.pathBytes, "base64"), Buffer.from("odd\nname.cpp"));
  assert.deepEqual(Buffer.from(unsafe.afterBytes, "base64"), Buffer.from(code));
});

test("an encoding-damaged regular file receives complete trusted physical source", async (t) => {
  const source = "int main(){return 0;}\n";
  const { nodes } = await corrections(
    t,
    {},
    { "main.cpp": source },
    { "main.cpp": Buffer.from([0xff, 0xfe]) },
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].repair.action, "create");
  assert.equal(nodes[0].repair.after, source);
});

test("a macro argument repair retains correct arguments and comments inside the changed argument", async (t) => {
  const header = "#define COMBINE(a,b) ((a)+(b))\n";
  const actual =
    '#include "defs.h"\nint main(){int base=0;return COMBINE(1 /*keep left*/ + 0, base /*keep right*/ + 9)==3?0:1;}\n';
  const expected =
    '#include "defs.h"\nint main(){int base=0;return COMBINE(1 + 0, base + 2)==3?0:1;}\n';
  const { nodes } = await corrections(
    t,
    {},
    { "defs.h": header, "main.cpp": expected },
    { "defs.h": header, "main.cpp": actual },
  );
  assert.ok(nodes.every(({ repair }) => repair.path === "main.cpp"));
  assert.equal(applySourceRepairs(actual, nodes), actual.replace("+ 9", "+ 2"));
});

test("macro token offsets retain UTF-16 prefixes and physical phase-2 continuations", async (t) => {
  const actual =
    '#define ADD(a,b) ((a)+(b))\r\nint main(){const char* label=u8"café 😀";return ADD(1 /*keep*/ +\\\r\n2, 9)==7?0:1;}\r\n';
  const expected = actual.replace(" /*keep*/", "").replace("\\\r\n", "").replace(", 9", ", 4");
  const { root, nodes } = await corrections(
    t,
    {},
    { "main.cpp": expected },
    { "main.cpp": actual },
  );
  const result = applySourceRepairs(actual, nodes);
  assert.equal(result, actual.replace(", 9", ", 4"));
  const file = path.join(root, "corrected.cpp");
  await writeFile(file, result);
  const build = spawnSync("/usr/bin/clang++", ["-std=c++17", "-fsyntax-only", file], {
    encoding: "utf8",
  });
  assert.equal(build.error, undefined);
  assert.equal(build.status, 0, build.stderr);
});

test("project macro context repair preserves a caller's independent comments and spacing", async (t) => {
  const caller = '#include "defs.h"\nint main(){return ID(1 /*keep*/ + 2)==3?0:1;}\n';
  const actual = { "defs.h": "#define OTHER(x) x\n", "main.cpp": caller };
  const expected = { "defs.h": "#define ID(x) x\n", "main.cpp": caller.replace(" /*keep*/", "") };
  const { nodes } = await corrections(t, {}, expected, actual);
  assert.ok(nodes.length > 0);
  assert.ok(nodes.every(({ repair }) => repair.path === "defs.h"));
  assert.deepEqual([...new Set(nodes.flatMap(({ differenceIds }) => differenceIds))].sort(), [
    "reference:0",
    "reference:1",
  ]);
});

test("restoring a project macro fixes its dependent canonical context without rewriting correct callers", async (t) => {
  const caller = '#include "defs.h"\nint main(){return ID(1+2) == 3 ? 0 : 1;}\n';
  const actual = { "defs.h": "#define OTHER(x) x\n", "main.cpp": caller };
  const expected = { "defs.h": "#define ID(x) x\n", "main.cpp": caller };
  const { root, nodes } = await corrections(t, {}, expected, actual);
  assert.ok(nodes.length > 0);
  assert.ok(nodes.every(({ repair }) => repair.path === "defs.h"));
  const fixed = { ...actual };
  for (const { repair } of [...nodes].reverse()) {
    assert.equal(repair.action, "replace");
    assert.equal(fixed[repair.path].split(repair.before).length - 1, 1);
    fixed[repair.path] = fixed[repair.path].replace(repair.before, repair.after);
  }
  assert.equal(fixed["main.cpp"], caller);
  const prepared = prepareCanonicalDiff(
    await canonicalizeTrustedProject({}),
    await canonicalizeTrustedProject(expected),
  );
  assert.deepEqual(
    compareCanonicalDiff(prepared, await canonicalizeTrustedProject(fixed)).differenceIds,
    [],
  );
  const project = path.join(root, "compiled");
  await mkdir(project);
  for (const [name, text] of Object.entries(fixed)) await writeFile(path.join(project, name), text);
  const build = spawnSync(
    "/usr/bin/clang++",
    ["-std=c++17", "-fsyntax-only", path.join(project, "main.cpp")],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(build.error, undefined);
  assert.equal(build.status, 0, build.stderr);
});

function applySourceRepairs(source, nodes) {
  let result = source;
  for (const { repair } of [...nodes].reverse()) {
    assert.equal(repair.action, "replace");
    assert.equal(result.split(repair.before).length - 1, 1);
    result = result.replace(repair.before, repair.after);
  }
  return result;
}

const physicalCases = /** @type {[string, string, string, string[]][]} */ ([
  [
    "multiple renamed definitions without swapping their accepted bodies or comments",
    "int a(){return 1;} // keep A\r\nint b(){return 2;} // keep B",
    "int y(){return 2;}\nint z(){return 1;}\n",
    ["int z(){return 1;} // keep A\r\nint y(){return 2;} // keep B"],
  ],
  [
    "multiple parameter renames while retaining each function identity",
    "int b(int y){return y+1;} // keep B\r\nint a(int x){return x;} // keep A",
    "int a(int value){return value;}\nint b(int value){return value+1;}\n",
    ["int b(int value){return value+1;} // keep B\r\nint a(int value){return value;} // keep A"],
  ],
  [
    "parameter renames in overloaded functions without losing signature identity",
    "int f(int x){return x;} // keep integer\r\nint f(double y){return (int)y+1;} // keep double",
    "int f(int value){return value;}\nint f(double value){return (int)value+1;}\n",
    [
      "int f(int value){return value;} // keep integer\r\nint f(double value){return (int)value+1;} // keep double",
    ],
  ],
  [
    "an added statement without replacing accepted statements or their comments",
    "int main(){int keep=0; /*keep body*/ return keep;}",
    "int main(){int keep=0; int added=0; return keep;}\n",
    ["int keep=0;", "/*keep body*/", "return keep;"],
  ],
  [
    "an extra macro argument without replacing correct parts of other arguments",
    "#define COMBINE(a,b) ((a)+(b))\nint main(){int base=0;return COMBINE(1 /*keep left*/ + 0, base /*keep right*/ + 9, 999)==3?0:1;}",
    "#define COMBINE(a,b) ((a)+(b))\nint main(){int base=0;return COMBINE(1 + 0, base + 2)==3?0:1;}\n",
    ["1 /*keep left*/ + 0", "base /*keep right*/ + 2"],
  ],
  [
    "a macro replacement token without discarding accepted gap bytes",
    "#define COMBINE(a,b) ((a)  \\\r\n  + (WRONG))\nint main(){return COMBINE(1,2)==3?0:1;}",
    "#define COMBINE(a,b) ((a) + (b))\nint main(){return COMBINE(1,2)==3?0:1;}\n",
    ["((a)  \\\r\n  + (b))"],
  ],
  [
    "a macro parameter rename without discarding accepted signature comments",
    "#define COMBINE(a,/*keep parameter*/wrong) ((a)+(b))\nint main(){return COMBINE(1,2)==3?0:1;}",
    "#define COMBINE(a,b) ((a)+(b))\nint main(){return COMBINE(1,2)==3?0:1;}\n",
    ["COMBINE(a,/*keep parameter*/b)"],
  ],
  [
    "adding a final definition without adding a final newline",
    "int z_helper(){return 2;}",
    "int z_helper() { return 2; }\nint a_user(){return z_helper();}\n",
    ["int z_helper(){return 2;}"],
  ],
  [
    "a renamed definition crossing canonical sort slots",
    "int z_helper(){return 2;}\r\n// keep this comment\r\nint a_old(){return z_helper();}\r\nint b_other(){return 3;}",
    "int z_helper() { return 2; }\nint a_new() { return z_helper(); }\nint b_other() { return 3; }\n",
    ["int z_helper(){return 2;}\r\n// keep this comment\r\n", "\r\nint b_other(){return 3;}"],
  ],
  [
    "inserting a callee-dependent definition without reordering existing definitions",
    "int z_helper(){return 2;}\nint b_other(){return 3;}\n",
    "int z_helper() { return 2; }\nint a_user() { return z_helper(); }\nint b_other() { return 3; }\n",
    ["int z_helper(){return 2;}", "int b_other(){return 3;}\n"],
  ],
  [
    "deleting only an erroneous definition",
    "int keep(){return 2;}\nint wrong(){return 9;}\n// keep EOF comment",
    "int keep() { return 2; }\n",
    ["int keep(){return 2;}", "// keep EOF comment"],
  ],
]);
for (const [name, actual, expected, retained] of physicalCases) {
  test(`physical correction handles ${name}`, async (t) => {
    const { root, nodes } = await corrections(
      t,
      {},
      { "main.cpp": expected },
      { "main.cpp": actual },
    );
    const result = applySourceRepairs(actual, nodes);
    for (const text of retained) assert.ok(result.includes(text));
    assert.equal(result.endsWith("\n"), actual.endsWith("\n"));
    const file = path.join(root, "corrected.cpp");
    await writeFile(file, result);
    const build = spawnSync("/usr/bin/clang++", ["-std=c++17", "-fsyntax-only", file], {
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(build.error, undefined);
    assert.equal(build.status, 0, build.stderr);
    const snapshot = await canonicalizeTrustedProject({ "main.cpp": result });
    const prepared = prepareCanonicalDiff(
      await canonicalizeTrustedProject({}),
      await canonicalizeTrustedProject({ "main.cpp": expected }),
    );
    assert.deepEqual(compareCanonicalDiff(prepared, snapshot).differenceIds, []);
  });
}

test("indistinguishable renamed physical owners fail closed instead of inheriting canonical sort positions", async (t) => {
  await assert.rejects(
    corrections(
      t,
      {},
      { "main.cpp": "int y(){return 1;}\nint z(){return 1;}\n" },
      { "main.cpp": "int a(){return 1;} // keep A\r\nint b(){return 1;} // keep B" },
    ),
    /Ambiguous physical definition correspondence/,
  );
});

test("a partial repair preserves correct physical comments, formatting and declaration order", async (t) => {
  const start = { "main.cpp": "int value() { return 1; }\nint other() { return 7; }\n" };
  const expected = { "main.cpp": "int value() { return 2; }\nint other() { return 7; }\n" };
  const actual = {
    "main.cpp":
      "// already completed: keep these bytes\nint other(){return 7;}\nint value(){ return 9; }\n",
  };
  const { nodes } = await corrections(t, start, expected, actual);
  let repaired = actual["main.cpp"];
  for (const { repair } of [...nodes].reverse()) {
    assert.equal(repair.action, "replace");
    assert.equal(repaired.split(repair.before).length - 1, 1);
    repaired = repaired.replace(repair.before, repair.after);
  }
  assert.equal(repaired, actual["main.cpp"].replace("return 9", "return 2"));
});
