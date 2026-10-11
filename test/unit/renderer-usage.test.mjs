import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizedUsage } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";

const usage = {
  input: 10,
  output: 3,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 16,
  cost: { total: 0.1 },
};

test("only finalized assistant and compaction usage is counted, and unavailable fields stay unknown", () => {
  const events = [
    { type: "message_update", assistantMessageEvent: { partial: { role: "assistant", usage } } },
    { type: "message_end", message: { role: "assistant", usage } },
    { type: "message_end", message: { role: "toolResult", usage } },
    { type: "agent_end", messages: [{ role: "assistant", usage }] },
    { type: "compaction_end", result: { usage } },
  ];
  assert.deepEqual(finalizedUsage(events), {
    input: 20,
    output: 6,
    cacheRead: 4,
    cacheWrite: 2,
    totalTokens: 32,
    cost: 0.2,
  });
  assert.equal(finalizedUsage([]), null);
  assert.equal(
    finalizedUsage([
      {
        type: "message_end",
        message: { role: "assistant", usage: { input: 0, output: 0, totalTokens: 0 } },
      },
    ]),
    null,
  );
  events.push({ type: "message_end", message: { role: "assistant", usage: { input: 5 } } });
  assert.deepEqual(finalizedUsage(events), {
    input: 25,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    totalTokens: null,
    cost: null,
  });
});
