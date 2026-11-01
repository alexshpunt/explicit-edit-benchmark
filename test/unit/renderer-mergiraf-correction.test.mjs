import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  prepareMergirafCorrection,
  validateMergirafRecords,
} from "../../src/suites/explicit-edit-multi-agent/execution/mergiraf-correction.mjs";

// A deliberately small third-party wire fixture, not a substitute C++ matcher.
function fixture() {
  const inputs = {
    base: Buffer.from("int x;\n"),
    actual: Buffer.from("int x;\n"),
    expected: Buffer.from("int y;\n"),
  };
  const records = [
    {
      record: "header",
      schema: "lpt944-mergiraf-pcs-probe-v1",
      engineVersion: "0.20.0",
      baseRole: "B",
      actualRole: "A",
      expectedRole: "E",
      strictSyntax: false,
      recoveryPolicy: "opaque-cst-regions",
      mergeExecuted: false,
    },
  ];
  for (const [revision, side] of [
    ["B", "base"],
    ["A", "actual"],
    ["E", "expected"],
  ]) {
    const text = inputs[side].toString();
    records.push({ record: "source", revision, text, bytes: Buffer.byteLength(text) });
    records.push({
      record: "node",
      revision,
      id: 2,
      leader: "B:2",
      kind: "translation_unit",
      field: null,
      start: 0,
      end: 6,
      parent: null,
      children: ["B:1"],
      leafText: null,
      collapsedAllThree: false,
    });
    records.push({
      record: "node",
      revision,
      id: 1,
      leader: "B:1",
      kind: "declaration",
      field: null,
      start: 0,
      end: 6,
      parent: "B:2",
      children: [],
      leafText: text.slice(0, 6),
      collapsedAllThree: false,
    });
    for (const triple of [
      ["ROOT", "START", "B:2"],
      ["ROOT", "B:2", "END"],
      ["B:2", "START", "B:1"],
      ["B:2", "B:1", "END"],
      ["B:1", "START", "END"],
    ])
      records.push({ record: "pcs", revision, triple });
  }
  for (const pair of ["B-A", "B-E", "A-E"]) {
    records.push({ record: "matching_summary", pair, full: 2 });
    for (const id of [1, 2]) records.push({ record: "matching", pair, leftId: id, rightId: id });
  }
  records.push({
    record: "node_value_delta",
    leader: "B:1",
    expectedKind: "declaration",
    expectedField: null,
    expectedLeafText: "int y;",
  });
  records.push({
    record: "summary",
    status: "ok",
    complete: true,
    baseNodes: 2,
    actualNodes: 2,
    expectedNodes: 2,
    actualPcs: 5,
    expectedPcs: 5,
    removePcs: 0,
    addPcs: 0,
    nodeValueChanges: 1,
    pcsDeltaReplayExact: true,
    astReplayVerified: false,
  });
  return { records, inputs };
}

test("native directed PCS and values reconstruct the reference using actual node identities", () => {
  const { records, inputs } = fixture();
  const proof = validateMergirafRecords(records, inputs);
  assert.deepEqual(proof.mappings, [
    [0, 0],
    [1, 1],
  ]);
  assert.equal(proof.actualNodes[0][0], 0);
  assert.equal(proof.actualNodes[0][5], -1);
  assert.equal(proof.actualNodes[1][5], 0);
  assert.equal(proof.verification.astReplayExact, true);
  assert.equal(proof.verification.sourceSha256.actual.length, 64);
});

for (const [name, mutate] of [
  [
    "wrong source bytes",
    ({ inputs }) => {
      inputs.actual = Buffer.from("int z;\n");
    },
  ],
  [
    "duplicate node class",
    ({ records }) => {
      records.push(structuredClone(records.find((r) => r.record === "node")));
    },
  ],
  [
    "missing value delta",
    ({ records }) => {
      records.splice(
        records.findIndex((r) => r.record === "node_value_delta"),
        1,
      );
    },
  ],
  [
    "wrong value delta",
    ({ records }) => {
      records.find((r) => r.record === "node_value_delta").expectedLeafText = "int z;";
    },
  ],
  [
    "orphan PCS edge",
    ({ records }) => {
      records.push({ record: "pcs", revision: "E", triple: ["B:2", "not-a-node", "END"] });
    },
  ],
  [
    "unsafe leaf source span",
    ({ records }) => {
      records.find((r) => r.record === "node" && r.leafText !== null).end--;
    },
  ],
  [
    "duplicate header",
    ({ records }) => {
      records.push(structuredClone(records[0]));
    },
  ],
  [
    "non-bijective matching",
    ({ records }) => {
      records.push({ record: "matching", pair: "A-E", leftId: 1, rightId: 2 });
    },
  ],
  [
    "silently merged output",
    ({ records }) => {
      records[0].mergeExecuted = true;
    },
  ],
  [
    "wrong engine version",
    ({ records }) => {
      records[0].engineVersion = "999.0";
    },
  ],
  [
    "truncated summary",
    ({ records }) => {
      records.pop();
    },
  ],
  [
    "unrecognized export record",
    ({ records }) => {
      records.push({ record: "unknown" });
    },
  ],
])
  test(`reject ${String(name)}`, () => {
    const item = fixture();
    mutate(item);
    assert.throws(() => validateMergirafRecords(item.records, item.inputs));
  });

test("opaque parser diagnostics survive successful source-complete recovery", () => {
  const { records, inputs } = fixture();
  records.push({
    record: "opaque_parse_recovery",
    revision: "A",
    diagnostic: "retained syntax diagnostic",
  });
  const result = validateMergirafRecords(records, inputs);
  assert.equal(result.verification.diagnostics[0].revision, "A");
  assert.equal(result.verification.diagnostics[0].diagnostic, "retained syntax diagnostic");
});

test("external protocol invocation saves byte identities and never overwrites evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-correction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { inputs, records } = fixture();
  const script = path.join(root, "third-party-wire-fixture.mjs");
  const lines = records.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(
    script,
    `import {mkdirSync,writeFileSync} from 'node:fs';import path from 'node:path';const out=process.argv.at(-1);mkdirSync(out);writeFileSync(path.join(out,'probe.ndjson'),${JSON.stringify(lines)});`,
  );
  const directory = path.join(root, "evidence");
  const options = { ...inputs, directory, command: [process.execPath, script] };
  const result = await prepareMergirafCorrection(options);
  assert.equal(result.verification.astReplayExact, true);
  assert.deepEqual(await readFile(path.join(directory, "actual.cpp")), inputs.actual);
  const receipt = JSON.parse(await readFile(path.join(directory, "execution.json")));
  assert.equal(receipt.exitCode, 0);
  assert.match(receipt.executableSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(prepareMergirafCorrection(options));
  assert.deepEqual(await readFile(path.join(directory, "actual.cpp")), inputs.actual);
});

test("failed native execution saves the real exit and diagnostics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-correction-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "evidence");
  await assert.rejects(
    prepareMergirafCorrection({
      ...fixture().inputs,
      directory,
      command: [process.execPath, "-e", "console.error('native failure');process.exit(7)"],
    }),
  );
  assert.equal(JSON.parse(await readFile(path.join(directory, "execution.json"))).exitCode, 7);
  assert.match(await readFile(path.join(directory, "stderr.txt"), "utf8"), /native failure/);
});

test("in-flight cancellation waits for native closure and preserves signal separately from exit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-correction-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const directory = path.join(root, "evidence");
  const ready = path.join(root, "ready");
  const events = watch(root, { signal: AbortSignal.timeout(5000) });
  const running = prepareMergirafCorrection({
    ...fixture().inputs,
    directory,
    signal: controller.signal,
    command: [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(99),10000)`,
    ],
  });
  let pid;
  for await (const event of events) {
    if (event.filename !== "ready") continue;
    // The create event may precede the write; an empty PID would query our own
    // process group (kill(0, 0)) rather than the child whose closure is tested.
    const value = await readFile(ready, "utf8");
    if (!/^[1-9]\d*$/.test(value)) continue;
    pid = Number(value);
    break;
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  controller.abort();
  await assert.rejects(running, { code: "ABORT_ERR" });
  const receipt = JSON.parse(await readFile(path.join(directory, "execution.json")));
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.signal, "SIGTERM");
  assert.equal(receipt.errorCode, "ABORT_ERR");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("cancelled or invalid UTF-8 input cannot start the native executable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-correction-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    ...fixture().inputs,
    directory: path.join(root, "evidence"),
    command: [process.execPath],
  };
  await assert.rejects(prepareMergirafCorrection({ ...options, actual: Buffer.from([0xff]) }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareMergirafCorrection({ ...options, signal: controller.signal }));
  await assert.rejects(readFile(path.join(options.directory, "actual.cpp")), { code: "ENOENT" });
});
