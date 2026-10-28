import assert from "node:assert/strict";
import test from "node:test";
import { restoringAgentProfile } from "../../src/suites/explicit-edit-multi-agent/execution/agent-profile.mjs";

test("run configuration selects fresh sessions and separates concurrency from graph width", () => {
  const config = {
    runtime: "runtime",
    model: "provider/model",
    thinking: "high",
    agentLifecycle: "per-delivery",
  };
  const profile = restoringAgentProfile({}, config, 15);
  assert.equal(profile.selected, true);
  assert.equal(profile.size, 30);
  assert.equal(profile.maxConcurrentAgents, 30);
  assert.deepEqual(profile.baseline, {
    runtime: "runtime",
    model: "provider/model",
    thinking: "high",
  });
  assert.equal(config.agentLifecycle, "per-delivery");
  assert.equal(restoringAgentProfile({}, {}, 15).selected, false);
  assert.equal(restoringAgentProfile({}, {}, 15).size, 15);
});

test("flags override run configuration without leaking profile keys into the model adapter", () => {
  const profile = restoringAgentProfile(
    { agentLifecycle: "persistent", maxConcurrentAgents: 3 },
    { agentLifecycle: "per-delivery", maxConcurrentAgents: 30, runtime: "runtime" },
    15,
  );
  assert.equal(profile.agentLifecycle, "persistent");
  assert.equal(profile.size, 3);
  assert.equal(profile.maxConcurrentAgents, 3);
  assert.deepEqual(profile.baseline, { runtime: "runtime" });
  assert.equal(
    restoringAgentProfile({ agentLifecycle: "persistent", maxConcurrentAgents: 30 }, {}, 15).size,
    15,
  );
});

for (const maxConcurrentAgents of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "30", null])
  test(`invalid concurrency configuration is rejected: ${String(maxConcurrentAgents)}`, () => {
    assert.throws(() => restoringAgentProfile({ maxConcurrentAgents }, {}, 15));
  });
test("an unknown lifecycle is rejected", () => {
  assert.throws(() => restoringAgentProfile({ agentLifecycle: "unknown" }, {}, 15));
});
