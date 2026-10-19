import assert from "node:assert/strict";
import test from "node:test";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

const node = (id) => ({ id, dependencies: [] });
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("deferred verification cannot accumulate an unbounded stream of fresh deliveries", async () => {
  const nodes = Array.from({ length: 24 }, (_, index) => node(`edit-${index}`));
  const first = new Set();
  let maximum = 0;
  const result = await runAtomicStream(nodes, {
    agents: 2,
    execute: async (_node, _agent, _signal, context) => {
      maximum = Math.max(maximum, context.started.size - context.completed.size);
    },
    verify: async (item) => {
      if (!first.has(item.id)) {
        first.add(item.id);
        return "pending";
      }
      await turn();
      return true;
    },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.completed.size, nodes.length);
  assert.ok(maximum <= 3, `two participants accumulated ${maximum} unverified deliveries`);
});

test(
  "a drained unchanged output gate blocks instead of spinning behind undispatched work",
  { timeout: 1000 },
  async () => {
    const assigned = [];
    const result = await runAtomicStream([node("first"), node("second"), node("third")], {
      agents: 1,
      execute: async (item) => assigned.push(item.id),
      verify: async () => "pending",
    });
    assert.equal(result.status, "blocked");
    assert.equal(new Set(assigned).size, assigned.length);
    assert.ok(assigned.length <= 2);
    assert.equal(result.completed.size, 0);
  },
);
