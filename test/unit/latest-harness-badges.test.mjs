import assert from "node:assert/strict";
import test from "node:test";

import { latestHarnessRows } from "../../scripts/build-public-dataset.mjs";

function row(version, passed) {
  return {
    harnessFamily: "pi-agent-ide",
    harnessVersion: version,
    benchmarkId: "explicit-edit-v1",
    benchmarkVersion: "1",
    trialSamples: [
      { taskId: "replace-literal", firstExactPassed: passed, finalExactPassed: passed },
    ],
  };
}

test("badge score uses only the latest accepted harness version", () => {
  const groups = latestHarnessRows([row("0.5.0", false), row("0.5.1", true)]);
  assert.deepEqual(
    groups["pi-agent-ide"].map((item) => item.harnessVersion),
    ["0.5.1"],
  );
});
