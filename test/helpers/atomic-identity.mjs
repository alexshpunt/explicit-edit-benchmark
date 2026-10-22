import { createHash } from "node:crypto";
import { ATOMIC_DISPATCH_POLICY } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

/** Synthetic atomic identity for local protocol tests, never release evidence. */
export function atomicIdentity() {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  return {
    version: ATOMIC_DISPATCH_POLICY.version,
    workloadSha256: hash("synthetic atomic workload"),
    batchesSha256: hash("synthetic private batches"),
    dispatchPolicySha256: hash(JSON.stringify(ATOMIC_DISPATCH_POLICY)),
    edits: 71,
  };
}
