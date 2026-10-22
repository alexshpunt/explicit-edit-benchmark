import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  scopedNamingSession,
  scopedNamingPlan,
  applyScopedNamePlan,
  currentNamingSelectors,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import { atomicWorkload } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-workload.mjs";

async function withSession(tree, request, run, options = {}) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/atomic-binding-session-"));
  const session = await scopedNamingSession(tree, directory, {
    ...options,
    file: request.category === "helpers" ? request.file : undefined,
  });
  try {
    await run(session, directory);
  } finally {
    session.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function functionRequest(signatures) {
  return {
    id: "functions",
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "old", to: "renamed" }],
    selectors: signatures.map((signature) => ({
      kind: "function",
      scope: "frond::old",
      owner: { scope: "frond::old", signature },
    })),
  };
}

function checkCpp(tree) {
  execFileSync("clang++-18", ["-std=c++17", "-x", "c++", "-fsyntax-only", "-"], {
    input: tree["main.cpp"],
  });
}

function rebasedOrigins(origins, applied) {
  const edits = applied.flatMap((plan) => plan.edits);
  return origins.map((origin) => ({
    ...origin,
    start:
      origin.start +
      edits
        .filter((edit) => edit.file === origin.file && edit.start < origin.start)
        .reduce((sum, edit) => sum + edit.new.length - edit.old.length, 0),
  }));
}

async function withEarlierTypeRename(run, parameters = false) {
  const tree = {
    "main.cpp": `namespace frond {
struct OldRecord { int member; };
using Alias = OldRecord;
int old(const Alias& arg);
int old(const OldRecord& arg) { return arg.member; }
int old(int arg) { return arg + 1; }
}
int main() { frond::OldRecord record{2}; return frond::old(record) + frond::old(3) == 6 ? 0 : 1; }
`,
  };
  const type = {
    id: "record",
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "OldRecord", to: "Record" }],
    selectors: [{ kind: "type", scope: "frond::OldRecord" }],
  };
  const request = parameters
    ? {
        id: "parameter",
        phase: "names",
        category: "locals-parameters",
        mapping: [{ from: "arg", to: "value" }],
        selectors: [
          {
            kind: "function",
            scope: "frond::old",
            signature: "int (const OldRecord &)",
            definition: true,
          },
        ],
      }
    : functionRequest(["int (const Alias &)", "int (const OldRecord &)"]);
  let selected = [];
  await withSession(
    tree,
    request,
    async (session, directory) => {
      const earlier = await session.atomicPlans(type);
      const certification = await session.atomicPlans(request);
      session.close();
      const applied = [earlier.plan];
      const current = applyScopedNamePlan(tree, earlier.plan);
      const groups = [
        selected,
        ...certification.atoms.map((atom) =>
          selected.filter((origin) =>
            atom.plan.edits.some(
              (edit) => edit.file === origin.file && edit.start === origin.start,
            ),
          ),
        ),
      ];
      await run({
        current,
        certification,
        groups: groups.map((group) => rebasedOrigins(group, applied)),
        applied,
        directory,
      });
    },
    {
      onSelection: (origins) => {
        selected = origins;
      },
    },
  );
}

test("refreshed alias binding selectors remain certified after an earlier type rename changes their function signatures", async () => {
  await withEarlierTypeRename(async ({ current, certification, groups, applied, directory }) => {
    const original = structuredClone(certification);
    const legacy = await currentNamingSelectors(current, groups, directory);
    assert.notDeepEqual(legacy[1], certification.atoms[0].operation.selectors);
    const refreshed = await currentNamingSelectors(
      current,
      groups,
      directory,
      [certification],
      applied,
    );
    const updated = refreshed.certifications[0];
    assert.equal(updated.atoms.length, 1);
    assert.equal(updated.operation.bindingGroups.length, 1);
    assert.equal(updated.operation.bindingGroups[0].selectors.length, 2);
    assert.ok(
      updated.atoms[0].operation.selectors.some(
        (selector) => selector.owner.signature === "int (const Record &)",
      ),
    );
    assert.deepEqual(updated.plan, original.plan);
    assert.deepEqual(updated.atoms[0].plan, original.atoms[0].plan);
    assert.deepEqual(certification, original);
    const [runtime] = await scopedNamingPlan(current, [updated.atoms[0].operation], directory);
    const expected = applyScopedNamePlan(current, certification.plan, applied);
    const actual = applyScopedNamePlan(current, runtime);
    assert.deepEqual(actual, expected);
    assert.ok(actual["main.cpp"].includes("int old(int arg)"));
    assert.ok(actual["main.cpp"].includes("frond::old(3)"));
    checkCpp(actual);
    const workload = atomicWorkload([
      { id: "task-001", phase: "names", operations: [updated.operation] },
    ]);
    assert.equal(workload.nodes.length, 1);
  });
});

test("refreshed parameter selectors replay only their original binding after an earlier owner type rename", async () => {
  await withEarlierTypeRename(async ({ current, certification, groups, applied, directory }) => {
    const { certifications } = await currentNamingSelectors(
      current,
      groups,
      directory,
      [certification],
      applied,
    );
    const atom = certifications[0].atoms[0];
    assert.equal(atom.operation.selectors[0].owner.signature, "int (const Record &)");
    const [runtime] = await scopedNamingPlan(current, [atom.operation], directory);
    const actual = applyScopedNamePlan(current, runtime);
    assert.deepEqual(actual, applyScopedNamePlan(current, certification.plan, applied));
    assert.ok(actual["main.cpp"].includes("int old(int arg) { return arg + 1; }"));
    checkCpp(actual);
  }, true);
});
test("refresh rejects dropped or changed compiler-certified declaration origins instead of merely hashing new selectors", async () => {
  await withEarlierTypeRename(async ({ current, certification, groups, applied, directory }) => {
    const missing = structuredClone(groups);
    missing[1].pop();
    await assert.rejects(
      currentNamingSelectors(current, missing, directory, [certification], applied),
      /certified declaration|certified.*origins/i,
    );
    const corrupt = structuredClone(certification);
    corrupt.atoms[0].declarations[0].start++;
    await assert.rejects(
      currentNamingSelectors(current, groups, directory, [corrupt], applied),
      /certified declaration|certified.*origins/i,
    );
  });
});

test("refresh rejects a new shadowed binding that the rebased public selector would also address", async () => {
  await withEarlierTypeRename(async ({ current, certification, groups, applied, directory }) => {
    const extra = {
      ...current,
      "main.cpp": current["main.cpp"].replace(
        "return arg.member;",
        "{ int arg = 1; (void)arg; } return arg.member;",
      ),
    };
    checkCpp(extra);
    await assert.rejects(
      currentNamingSelectors(extra, groups, directory, [certification], applied),
      /same declarations|selector.*binding/i,
    );
  }, true);
});

test("unrelated lambda-local observations do not block a certified function selector refresh", async () => {
  await withEarlierTypeRename(async ({ current, certification, groups, applied, directory }) => {
    const extra = {
      ...current,
      "main.cpp":
        current["main.cpp"] +
        `
namespace unrelated {
int calculate(int value) {
  auto transform = [](int argument) {
    int local = argument + 1;
    return local;
  };
  return transform(value);
}
}
`,
    };
    const { certifications } = await currentNamingSelectors(
      extra,
      groups,
      directory,
      [certification],
      applied,
    );
    const [runtime] = await scopedNamingPlan(
      extra,
      [certifications[0].atoms[0].operation],
      directory,
    );
    assert.deepEqual(
      applyScopedNamePlan(extra, runtime),
      applyScopedNamePlan(extra, certification.plan, applied),
    );
    checkCpp(applyScopedNamePlan(extra, runtime));
    await assert.rejects(
      currentNamingSelectors(
        extra,
        [
          [
            {
              file: "main.cpp",
              start: extra["main.cpp"].indexOf("local ="),
              role: "variable",
            },
          ],
        ],
        directory,
      ),
      /Ambiguous current declaration owner/,
    );
  });
});

test("refresh retains later lambda-local identities when checking for extra selected bindings", async () => {
  const tree = {
    "main.cpp": `namespace frond {
int calculate(int value) {
  struct Local { int member; };
  return value;
}
}
`,
  };
  const request = {
    id: "local-type",
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "Local", to: "Restored" }],
    selectors: [{ kind: "type", scope: "frond::calculate::Local" }],
  };
  await withSession(tree, request, async (session, directory) => {
    const certification = await session.atomicPlans(request);
    session.close();
    const origins = certification.atoms[0].declarations;
    const extra = {
      "main.cpp": tree["main.cpp"].replace(
        "return value;",
        `auto transform = [](int argument) {
    struct Local { int member; };
    return argument;
  };
  return transform(value);`,
      ),
    };
    checkCpp(extra);
    await assert.rejects(
      currentNamingSelectors(extra, [origins, origins], directory, [certification]),
      /same declarations|selector.*binding/i,
    );
  });
});

test("one snapshot certifies separate overload atoms and their union matches the original plan", async () => {
  const tree = {
    "main.cpp": `namespace frond {
int old(int x); double old(double x);
int old(int x) { return x; } double old(double x) { return x; }
}
namespace other { int old(int x) { return x + 1; } }
int main() { return frond::old(2) + frond::old(3.0) + other::old(4) == 10 ? 0 : 1; }
`,
  };
  const request = functionRequest(["int (int)", "double (double)"]);
  await withSession(tree, request, async (session, directory) => {
    const result = await session.atomicPlans(request);
    assert.equal(result.operation.bindingGroups.length, 2);
    assert.equal(result.atoms.length, 2);
    assert.equal(result.plan.edits.length, 6);
    const groups = [
      result.atoms.flatMap((atom) => atom.declarations),
      ...result.atoms.map((atom) => atom.declarations),
    ];
    const refreshed = await currentNamingSelectors(tree, groups, directory, [result]);
    assert.deepEqual(refreshed.certifications[0].atoms, result.atoms);
    assert.deepEqual(refreshed.certifications[0].plan, result.plan);
    assert.deepEqual(
      refreshed.certifications[0].operation.bindingGroups,
      result.operation.bindingGroups,
    );
    await assert.rejects(
      currentNamingSelectors(tree, [groups[0], groups[2], groups[1]], directory, [result]),
      /certified declarations/,
    );
    assert.deepEqual(
      result.atoms.map((atom) => atom.bindingGroup),
      [0, 1],
    );
    const workload = atomicWorkload([
      { id: "task-001", phase: "names", operations: [result.operation] },
    ]);
    assert.equal(workload.nodes.length, 2);
    assert.equal(workload.summary.renameMappings, 1);
    for (const atom of result.atoms) {
      assert.equal(atom.operation.mapping.length, 1);
      assert.equal(atom.plan.edits.length, 3);
      const [replanned] = await scopedNamingPlan(tree, [atom.operation], directory);
      assert.deepEqual(replanned.edits, atom.plan.edits);
      const after = applyScopedNamePlan(tree, atom.plan);
      assert.ok(after["main.cpp"].includes("namespace other { int old(int x)"));
      checkCpp(after);
    }
    let after = tree;
    const applied = [];
    for (const atom of result.atoms) {
      after = applyScopedNamePlan(after, atom.plan, applied);
      applied.push(atom.plan);
    }
    assert.deepEqual(after, applyScopedNamePlan(tree, result.plan));
    checkCpp(after);
  });
});

test("alias-equivalent written declaration and definition signatures form one binding group", async () => {
  const tree = {
    "main.cpp": `namespace frond {
using Alias = int;
int old(int x); int old(Alias x) { return x; }
}
int main() { return frond::old(2); }
`,
  };
  const request = functionRequest(["int (int)", "int (Alias)"]);
  await withSession(tree, request, async (session) => {
    const result = await session.atomicPlans(request);
    assert.equal(result.atoms.length, 1);
    assert.equal(result.operation.bindingGroups[0].selectors.length, 2);
    assert.deepEqual(result.atoms[0].plan.edits, result.plan.edits);
    assert.equal(result.plan.edits.length, 3);
    checkCpp(applyScopedNamePlan(tree, result.plan));
  });
});

test("same-spelling parameters in different owners are addressable as separate variable atoms", async () => {
  const tree = {
    "main.cpp": `namespace frond {
int first(int arg) { return arg; }
int second(int arg) { return arg + 1; }
int untouched(int arg) { return arg + 2; }
}
int main() { return frond::first(1) + frond::second(2) + frond::untouched(3) == 9 ? 0 : 1; }
`,
  };
  const request = {
    id: "parameters",
    phase: "names",
    category: "locals-parameters",
    mapping: [{ from: "arg", to: "value" }],
    selectors: ["first", "second"].map((name) => ({
      kind: "function",
      scope: `frond::${name}`,
      signature: "int (int)",
      definition: true,
    })),
  };
  await withSession(tree, request, async (session, directory) => {
    const result = await session.atomicPlans(request);
    assert.equal(result.atoms.length, 2);
    for (const atom of result.atoms) {
      assert.equal(atom.operation.selectors[0].kind, "variable");
      const [replanned] = await scopedNamingPlan(tree, [atom.operation], directory);
      assert.deepEqual(replanned.edits, atom.plan.edits);
      const after = applyScopedNamePlan(tree, atom.plan);
      assert.ok(after["main.cpp"].includes("int untouched(int arg) { return arg + 2; }"));
      checkCpp(after);
    }
  });
});

test("indistinguishable shadowed locals reject certification without consuming the original plan", async () => {
  const tree = {
    "main.cpp": `int f(int arg) { int result = arg; { int arg = 2; result += arg; } return result; }
int main() { return f(1); }
`,
  };
  const request = {
    id: "shadow",
    phase: "names",
    category: "locals-parameters",
    mapping: [{ from: "arg", to: "value" }],
    selectors: [{ kind: "function", scope: "f", signature: "int (int)", definition: true }],
  };
  await withSession(tree, request, async (session) => {
    await assert.rejects(
      session.atomicPlans(request),
      /public selector.*binding|indistinguishable/i,
    );
    const plan = await session.plan(request);
    assert.equal(plan.edits.length, 4);
    await assert.rejects(session.plan(request), /already changed/);
  });
});

test("selector-less helpers certify exact function and constant selectors without broadening delivered atoms", async () => {
  const tree = {
    "main.cpp": "int main() { return 0; }\n",
    "helpers.cpp": `namespace frond { static int old(int x) { return x; } int use() { return old(2); } }
namespace other { static int old(int x) { return x + 1; } int use() { return old(3); } }
namespace constants { static const int old = 4; int use() { return old; } }
`,
  };
  const request = {
    id: "helpers",
    phase: "names",
    category: "helpers",
    file: "helpers.cpp",
    mapping: [{ from: "old", to: "renamed" }],
  };
  await withSession(tree, request, async (session, directory) => {
    const result = await session.atomicPlans(request);
    assert.equal(result.atoms.length, 3);
    for (const atom of result.atoms) {
      const local = await scopedNamingSession(tree, directory, { file: request.file });
      try {
        const replanned = await local.plan(atom.operation);
        assert.deepEqual(replanned.edits, atom.plan.edits);
        assert.equal(replanned.edits.length, 2);
      } finally {
        local.close();
      }
      const after = applyScopedNamePlan(tree, atom.plan);
      const constant = atom.operation.selectors[0].kind === "variable";
      assert.equal(
        (after["helpers.cpp"].match(/static int old\(/g) ?? []).length,
        constant ? 2 : 1,
      );
      assert.ok(
        after["helpers.cpp"].includes(`static const int ${constant ? "renamed" : "old"} = 4;`),
      );
    }
  });
});

test("shared macro reference tokens cause partial plan overlap and fail before consumption", async () => {
  const tree = {
    "main.cpp": `#define READ_ARG arg
int first(int arg) { return READ_ARG; }
int second(int arg) { return READ_ARG; }
int main() { return first(1) + second(2); }
`,
  };
  const request = {
    id: "macro",
    phase: "names",
    category: "locals-parameters",
    mapping: [{ from: "arg", to: "value" }],
    selectors: ["first", "second"].map((scope) => ({
      kind: "function",
      scope,
      signature: "int (int)",
      definition: true,
    })),
  };
  await withSession(tree, request, async (session) => {
    await assert.rejects(
      session.atomicPlans(request),
      /Partially overlapping compiler binding plans/,
    );
    const plan = await session.plan(request);
    const after = applyScopedNamePlan(tree, plan);
    checkCpp(after);
    assert.ok(after["main.cpp"].includes("#define READ_ARG value"));
  });
});
test("multiple original mappings retain exact coarse-plan coverage and cannot certify an absent mapping", async () => {
  const tree = {
    "main.cpp":
      "int f(int arg) { int temporary = arg; return temporary; }\nint main() { return f(2); }\n",
  };
  const request = {
    id: "two-mappings",
    phase: "names",
    category: "locals-parameters",
    mapping: [
      { from: "arg", to: "value" },
      { from: "temporary", to: "result" },
    ],
    selectors: [{ kind: "function", scope: "f", signature: "int (int)", definition: true }],
  };
  await withSession(tree, request, async (session, directory) => {
    const absent = {
      ...request,
      mapping: [...request.mapping, { from: "missing", to: "present" }],
    };
    await assert.rejects(session.atomicPlans(absent), /Missing current owner\/signature binding/);
    const result = await session.atomicPlans(request);
    assert.equal(result.operation.mapping.length, 2);
    assert.equal(result.atoms.length, 2);
    const [coarse] = await scopedNamingPlan(tree, [request], directory);
    assert.deepEqual(applyScopedNamePlan(tree, result.plan), applyScopedNamePlan(tree, coarse));
    const workload = atomicWorkload([
      { id: "task-001", phase: "names", operations: [result.operation] },
    ]);
    assert.equal(workload.summary.renameMappings, 2);
    assert.equal(workload.summary.namingBindings, 2);
  });
});
test("compiler-location types never enter public atomic selectors", async () => {
  const tree = {
    "main.cpp": "auto old() { return [] { return 1; }; }\nint main() { return old()(); }\n",
  };
  const request = {
    id: "lambda-return",
    phase: "names",
    category: "functions-types",
    mapping: [{ from: "old", to: "renamed" }],
    selectors: [{ kind: "function", scope: "old" }],
  };
  await withSession(tree, request, async (session) => {
    await assert.rejects(session.atomicPlans(request), /private compiler-location signature/);
    checkCpp(applyScopedNamePlan(tree, await session.plan(request)));
  });
});
test("certified plans consume each origin once and cannot be replayed through the coarse API", async () => {
  const tree = { "main.cpp": "int f(int arg) { return arg; }\nint main() { return f(2); }\n" };
  const request = {
    id: "parameter",
    phase: "names",
    category: "locals-parameters",
    mapping: [{ from: "arg", to: "value" }],
    selectors: [{ kind: "function", scope: "f", signature: "int (int)", definition: true }],
  };
  await withSession(tree, request, async (session) => {
    await session.atomicPlans(request);
    await assert.rejects(session.plan(request), /already changed/);
    await assert.rejects(session.atomicPlans(request), /already changed/);
  });
});
