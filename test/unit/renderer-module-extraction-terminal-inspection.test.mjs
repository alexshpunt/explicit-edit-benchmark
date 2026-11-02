import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTerminalInspector } from "../../src/suites/explicit-edit-multi-agent/extraction/terminal-inspection.mjs";

const request = {
  runId: "run-1",
  sequence: 2,
  stage: "original",
  round: 3,
  ids: ["file-1"],
  candidateIdentity: "a".repeat(64),
  evidence: "/evidence",
  report: "/report",
};

test("inspection waits for an explicit approval tied to the shown snapshot", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let displayed = "";
  output.on("data", (data) => {
    displayed += data;
  });
  const inspect = createTerminalInspector({ input, output });
  const pending = inspect(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(displayed, new RegExp(request.candidateIdentity));
  assert.match(displayed, /\/evidence/);
  input.write(`approve ${request.sequence} ${request.candidateIdentity}\n`);
  assert.deepEqual(await pending, {
    runId: request.runId,
    sequence: request.sequence,
    candidateIdentity: request.candidateIdentity,
  });
  inspect.close();
});

test("inspection refuses a wrong approval and an interrupted input", async () => {
  for (const answer of ["approve wrong\n", `approve 1 ${request.candidateIdentity}\n`, null]) {
    const input = new PassThrough(),
      output = new PassThrough();
    const inspect = createTerminalInspector({ input, output });
    const pending = inspect(request);
    if (answer === null) input.end();
    else input.write(answer);
    await assert.rejects(pending);
    inspect.close();
  }
});
