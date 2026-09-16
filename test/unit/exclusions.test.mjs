import assert from "node:assert/strict";
import test from "node:test";

import { applyExclusions, validateExclusionRegistry } from "../../scripts/exclusions.mjs";

const revision = "a".repeat(40);
const digest = "b".repeat(64);
const baseRegistry = {
  schemaVersion: 1,
  policyId: "benchmark-exclusions-v1",
  decisions: [
    {
      id: "bad-package-build",
      status: "active",
      scope: "canonical-comparisons",
      selector: {
        kind: "package",
        name: "example-extension",
        version: "1.2.3",
        digestSha256: digest,
      },
      reason: "Published package contained benchmark-aware behavior.",
      decisionRevision: revision,
    },
  ],
};

await test("an exact package exclusion does not affect a neighboring build", () => {
  const profiles = [
    {
      runId: "run-1",
      profileId: "excluded",
      configurationHash: "1".repeat(64),
      packages: [{ name: "example-extension", version: "1.2.3", digestSha256: digest }],
    },
    {
      runId: "run-1",
      profileId: "kept-version",
      configurationHash: "2".repeat(64),
      packages: [{ name: "example-extension", version: "1.2.4", digestSha256: digest }],
    },
    {
      runId: "run-1",
      profileId: "kept-digest",
      configurationHash: "3".repeat(64),
      packages: [{ name: "example-extension", version: "1.2.3", digestSha256: "c".repeat(64) }],
    },
  ];

  const result = applyExclusions(baseRegistry, { profiles, trials: [] });

  assert.deepEqual(
    result.profiles.map((profile) => profile.profileId),
    ["kept-version", "kept-digest"],
  );
  assert.deepEqual(result.applied, [
    {
      decisionId: "bad-package-build",
      runId: "run-1",
      profileId: "excluded",
      configurationHash: "1".repeat(64),
    },
  ]);
  assert.equal(profiles.length, 3, "raw observations stay unchanged");
});

await test("withdrawing a decision restores the same observations", () => {
  const profiles = [{ runId: "run-1", profileId: "profile", configurationHash: "d".repeat(64) }];
  const trials = [{ runId: "run-1", profileId: "profile", trialId: "trial-1" }];
  const registry = {
    ...baseRegistry,
    decisions: [
      {
        id: "wrong-measurement",
        status: "active",
        scope: "canonical-comparisons",
        selector: { kind: "configuration", configurationHash: "d".repeat(64) },
        reason: "The adapter measured the wrong workspace.",
        decisionRevision: revision,
      },
    ],
  };

  assert.equal(applyExclusions(registry, { profiles, trials }).trials.length, 0);
  const withdrawn = {
    ...registry,
    decisions: registry.decisions.map((decision) => ({ ...decision, status: "withdrawn" })),
  };
  assert.deepEqual(applyExclusions(withdrawn, { profiles, trials }).trials, trials);
});

await test("the same registry and source rebuild deterministically without changing raw hashes", () => {
  const evidence = {
    profiles: [{ runId: "run-1", profileId: "profile", configurationHash: "d".repeat(64) }],
    trials: [{ runId: "run-1", profileId: "profile", trialId: "trial-1" }],
    rounds: [{ runId: "run-1", trialId: "trial-1", roundId: "round-1" }],
    toolCalls: [{ runId: "run-1", roundId: "round-1", toolCallId: "call-1" }],
  };
  const before = JSON.stringify(evidence);
  const registry = {
    ...baseRegistry,
    decisions: [
      {
        id: "wrong-measurement",
        status: "active",
        scope: "canonical-comparisons",
        selector: { kind: "configuration", configurationHash: "d".repeat(64) },
        reason: "The adapter measured the wrong workspace.",
        decisionRevision: revision,
      },
    ],
  };

  assert.deepEqual(applyExclusions(registry, evidence), applyExclusions(registry, evidence));
  assert.equal(JSON.stringify(evidence), before);
});

await test("the registry rejects broad or candidate-controlled selectors", () => {
  assert.throws(
    () =>
      validateExclusionRegistry({
        ...baseRegistry,
        decisions: [
          {
            ...baseRegistry.decisions[0],
            selector: { kind: "package", name: "example-extension", version: "1.2.3" },
          },
        ],
      }),
    /selector fields/,
  );
  assert.throws(
    () => validateExclusionRegistry({ ...baseRegistry, decisions: [], extra: true }),
    /registry fields/,
  );
});
