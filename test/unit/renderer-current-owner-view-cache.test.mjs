import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const request = (from, to, owner = "refine") => ({
  id: `${owner}-${from}`,
  operations: [
    {
      id: `${owner}-${from}`,
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from, to }],
      selectors: [
        {
          kind: "variable",
          scope: `api::${owner}::${from}`,
          owner: { scope: `api::${owner}`, signature: "int (int, int)", definition: true },
        },
      ],
    },
  ],
});
const input = {
  "part.cpp":
    "namespace api { static int refine(int first, int second) { return first + second; } }\n",
  "peer.cpp": "namespace api { static int refine(float other) { return missing_helper(); } }\n",
};
async function fixture(t) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/owner-view-cache-"));
  const compiler = execFileSync("which", ["clang++"], { encoding: "utf8" }).trim();
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "clang++"),
    `#!/bin/sh\nfor arg do\n  if [ "$arg" = "-E" ]; then echo 'Unexpected owner preprocessing' >&2; exit 87; fi\ndone\nexec '${compiler.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const planner = currentNamingPlanner(path.join(directory, "analysis"));
  t.after(async () => {
    process.env.PATH = previousPath;
    planner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    planner,
    stopPreprocessing: () => {
      process.env.PATH = `${bin}:${previousPath}`;
    },
  };
}
test("acknowledged definition-local renames reuse owner preprocessing and compiler bindings", async (t) => {
  const { planner, stopPreprocessing } = await fixture(t);
  const first = await planner.plan(input, request("first", "left"));
  planner.acknowledge(input, first.after);
  stopPreprocessing();
  const second = await planner.plan(first.after, request("second", "right"));
  assert.deepEqual(second.after, {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("first", "left").replaceAll("second", "right"),
  });
  assert.equal(second.statistics.snapshotAttempts, 1);
  assert.equal(second.statistics.cacheHits, 1);
  planner.acknowledge(first.after, second.after);
  const unknown = {
    ...second.after,
    "peer.cpp": second.after["peer.cpp"] + "// unknown peer write\n",
  };
  await assert.rejects(
    planner.plan(unknown, request("left", "position")),
    /Unexpected owner preprocessing/,
  );
});
test("a request using an earlier destination spelling reopens the actual owner source", async (t) => {
  const { planner } = await fixture(t);
  const first = await planner.plan(input, request("first", "left"));
  planner.acknowledge(input, first.after);
  const next = await planner.plan(first.after, request("left", "position"));
  assert.deepEqual(next.after, {
    ...input,
    "part.cpp": input["part.cpp"].replaceAll("first", "position"),
  });
  assert.equal(next.statistics.snapshotAttempts, 2);
});
test("an acknowledged header change still reopens actual owner preprocessing", async (t) => {
  const { planner, stopPreprocessing } = await fixture(t);
  const before = {
    ...input,
    "api.h":
      "#pragma once\nnamespace api { inline int boundary(int first, int second) { return first + second; } }\n",
    "part.cpp": '#include "api.h"\n' + input["part.cpp"],
  };
  const first = await planner.plan(before, request("first", "left"));
  planner.acknowledge(before, first.after);
  const header = await planner.plan(first.after, request("first", "header_left", "boundary"));
  planner.acknowledge(first.after, header.after);
  stopPreprocessing();
  await assert.rejects(
    planner.plan(header.after, request("second", "right")),
    /Unexpected owner preprocessing/,
  );
});
