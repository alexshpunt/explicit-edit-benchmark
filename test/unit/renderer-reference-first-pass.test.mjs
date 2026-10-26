import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REFERENCE_EXECUTION_POLICY,
  referenceFirstPass,
  validateReferenceExecution,
} from "../../src/suites/explicit-edit-multi-agent/reference/execution-proof.mjs";

import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";

test("reference mode rejects paid configuration before opening files or drivers", async () => {
  await assert.rejects(
    runConcurrent("absent-preparation", "absent-output", {
      configPath: "private-config",
      reference: true,
    }),
    { code: "ERR_ASSERTION" },
  );
});

test("reference purpose must be a boolean before opening files or drivers", async () => {
  await assert.rejects(
    runConcurrent("absent-preparation", "absent-output", { reference: "true" }),
    { code: "ERR_ASSERTION" },
  );
});
function report() {
  return {
    acceptedRounds: 1,
    totalRounds: 1,
    repairs: 0,
    atomicBarriers: [{ round: "round-001", attempt: 1, status: "accepted" }],
    checks: [
      { contractId: "initial", status: "pass" },
      { contractId: "round-001", status: "pass" },
    ],
    executions: [{ attempt: 1, status: "settled", atomicIds: ["atom-1"] }],
  };
}
function proof() {
  const source = report();
  return {
    acceptedRounds: 1,
    acceptedAtomicEdits: 1,
    repairs: 0,
    referenceExecution: REFERENCE_EXECUTION_POLICY,
    referenceFirstPass: referenceFirstPass(source),
    referenceConcurrency: {
      executors: 15,
      maxWorking: 15,
      maxPlanning: 15,
      maxPublishing: 2,
      workIntervals: 15,
      planningIntervals: 15,
      publicationIntervals: 15,
    },
  };
}

test("first-pass evidence is derived from accepted original deliveries and passing checks", () => {
  const original = report();
  const evidence = referenceFirstPass(original);
  assert.equal(evidence.repairs, 0);
  assert.equal(evidence.repairDeliveries, 0);
  assert.equal(evidence.originalAtomicEdits, 1);
  validateReferenceExecution(proof(), 15);
  original.atomicBarriers[0].attempt = 2;
  assert.equal(evidence.barriers[0].attempt, 1);
});

/** @type {Array<[string, (value: any) => void]>} */
const invalidReports = [
  [
    "repair blocks",
    (r) => {
      r.repairs = 1;
    },
  ],
  [
    "a second barrier attempt",
    (r) => {
      r.atomicBarriers[0].attempt = 2;
    },
  ],
  [
    "a failed barrier",
    (r) => {
      r.atomicBarriers[0].status = "failed";
    },
  ],
  [
    "a failed initial check",
    (r) => {
      r.checks[0].status = "fail";
    },
  ],
  [
    "a failed round check",
    (r) => {
      r.checks[1].status = "fail";
    },
  ],
  [
    "a repeated round check",
    (r) => {
      r.checks.push({ ...r.checks[1] });
    },
  ],
  [
    "a repair delivery",
    (r) => {
      r.executions[0].deliveryKind = "barrier-repair";
    },
  ],
  [
    "a repeated delivery attempt",
    (r) => {
      r.executions[0].attempt = 2;
    },
  ],
  [
    "empty original coverage",
    (r) => {
      r.executions[0].atomicIds = [];
    },
  ],
  [
    "a repeated original atom",
    (r) => {
      r.executions.push({ ...r.executions[0] });
    },
  ],
];
for (const [name, corrupt] of invalidReports)
  test(`reference evidence rejects ${name}`, () => {
    const r = report();
    corrupt(r);
    assert.throws(() => referenceFirstPass(r));
  });

/** @type {Array<[string, (value: any) => void]>} */
const invalidProofs = [
  [
    "missing first-pass evidence",
    (p) => {
      delete p.referenceFirstPass;
    },
  ],
  [
    "nonzero repair count",
    (p) => {
      p.repairs = 1;
    },
  ],
  [
    "a recovered barrier",
    (p) => {
      p.referenceFirstPass.barriers[0].attempt = 2;
    },
  ],
  [
    "failed checks",
    (p) => {
      p.referenceFirstPass.checks[0].status = "fail";
    },
  ],
  [
    "uncovered rounds",
    (p) => {
      p.acceptedRounds = 2;
    },
  ],
  [
    "incomplete original inventory",
    (p) => {
      p.acceptedAtomicEdits = 2;
    },
  ],
];
for (const [name, corrupt] of invalidProofs)
  test(`reference authorization rejects ${name}`, () => {
    const p = proof();
    corrupt(p);
    assert.throws(() => validateReferenceExecution(p, 15));
  });
