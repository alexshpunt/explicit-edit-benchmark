import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { scopedNamingSession } from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

test("a closed compiler session cannot keep serving selections or plans", async () => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/closed-compiler-"));
  const request = {
    phase: "names",
    category: "locals-parameters",
    mapping: [{ from: "old", to: "current" }],
    selectors: [
      {
        kind: "variable",
        scope: "work::old",
        owner: { scope: "work", signature: "int (int)", definition: true },
      },
    ],
  };
  let session;
  try {
    session = await scopedNamingSession(
      { "main.cpp": "int work(int old) { return old; }\n" },
      directory,
      { file: "main.cpp" },
    );
    assert.equal(session.hasLocalBinding(request), true);
    session.close();
    assert.throws(() => session.hasLocalBinding(request), /closed/);
    await assert.rejects(session.plan(request), /closed/);
    await assert.rejects(session.atomicPlans(request), /closed/);
    session.close();
  } finally {
    session?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
