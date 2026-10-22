import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { currentNamingPlanner } from "../../src/suites/explicit-edit-multi-agent/reference/current-naming-service.mjs";

const request = (from, to) => ({
  id: from,
  operations: [
    {
      id: from,
      phase: "names",
      category: "functions-types",
      mapping: [{ from, to }],
      selectors: [{ kind: "type", scope: from }],
    },
  ],
});

test("an explained full compiler view does not depend on redundant preprocessing for independent types", async () => {
  const compiler = execFileSync("which", ["clang++"], { encoding: "utf8" }).trim();
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/full-view-preprocessing-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "clang++"),
    `#!/bin/sh\nfor arg do\n  if [ "$arg" = "-E" ]; then echo 'Redundant preprocessing unavailable' >&2; exit 87; fi\ndone\nexec '${compiler.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const planner = currentNamingPlanner(path.join(directory, "analysis"));
  try {
    const before = {
      "api.h":
        "#pragma once\nstruct First { int value; };\nstruct Second { int value; };\nstruct Third { int value; };\n",
      "main.cpp":
        '#include "api.h"\n#if 0\n#define int long\n#endif\nint consume(First value) { return value.value; }\n',
    };
    const first = await planner.plan(before, request("First", "FirstNew"));
    planner.acknowledge(before, first.after);
    const second = await planner.plan(first.after, request("Second", "SecondNew"));
    assert.deepEqual(second.after, {
      "api.h": before["api.h"].replaceAll("First", "FirstNew").replaceAll("Second", "SecondNew"),
      "main.cpp": before["main.cpp"].replaceAll("First", "FirstNew"),
    });
    assert.equal(second.statistics.snapshotAttempts, 1);
    assert.equal(second.statistics.cacheHits, 1);
    planner.acknowledge(first.after, second.after);
    const unknown = {
      ...second.after,
      "main.cpp": second.after["main.cpp"] + "int peer() { return 2; }\n",
    };
    await assert.rejects(
      planner.plan(unknown, request("Third", "ThirdNew")),
      /Redundant preprocessing unavailable/,
    );
  } finally {
    planner.close();
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
