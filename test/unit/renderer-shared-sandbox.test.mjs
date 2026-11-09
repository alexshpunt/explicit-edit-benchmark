import assert from "node:assert/strict";
import test from "node:test";
import {
  SHARED_SERVER_MARKER,
  participantTree,
} from "../../src/suites/explicit-edit-multi-agent/execution/shared-sandbox.mjs";

test("an agent's processes exclude the shared language server it started", () => {
  const table = [
    { pid: 1, ppid: 0, start: "1", command: "bwrap init" },
    { pid: 10, ppid: 1, start: "10", command: "node pi agent A" },
    { pid: 11, ppid: 10, start: "11", command: "bash -c sed -i main.cpp" },
    { pid: 12, ppid: 11, start: "12", command: "python3 edit.py" },
    { pid: 13, ppid: 10, start: "13", command: `node /runtime/lsp/${SHARED_SERVER_MARKER} sock` },
    { pid: 14, ppid: 13, start: "14", command: "clangd" },
    { pid: 20, ppid: 1, start: "20", command: "node pi agent B" },
  ];
  assert.deepEqual(
    participantTree(table, 10).map(({ pid }) => pid),
    [10, 11, 12],
  );
  assert.deepEqual(participantTree(table, 99), []);
});
