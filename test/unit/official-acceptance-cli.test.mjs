import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceExitCode } from "../../scripts/official-acceptance-cli.mjs";

const rejected = { rejected: [{ candidate: 61, code: "invalid-contract" }] };

test("scheduled acceptance reports candidate rejection without failing the batch", () => {
  assert.equal(acceptanceExitCode("poll", rejected), 0);
});

test("explicit acceptance fails when its requested candidate is rejected", () => {
  assert.equal(acceptanceExitCode("accept", rejected), 1);
  assert.equal(acceptanceExitCode("accept", { rejected: [] }), 0);
});
