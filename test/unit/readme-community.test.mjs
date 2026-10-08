import assert from "node:assert/strict";
import test from "node:test";

import { contributorBadgeData, syncReadmeCommunity } from "../../scripts/sync-readme-community.mjs";

test("README community sync changes only its marked block and is stable", () => {
  const source = [
    "before",
    "<!-- benchmark-community:start -->",
    "old",
    "<!-- benchmark-community:end -->",
    "after",
  ].join("\n");
  const community = {
    contributors: [
      {
        accountId: "alice",
        profileUrl: "https://huggingface.co/alice",
        acceptedRuns: 2,
        configurations: 3,
      },
    ],
    harnesses: [{ harnessFamily: "pi-default", acceptedRuns: 4, configurations: 2 }],
  };

  const updated = syncReadmeCommunity(source, community);

  assert.ok(updated.startsWith("before\n"));
  assert.ok(updated.endsWith("\nafter"));
  assert.match(updated, /\[@alice\]\(https:\/\/huggingface\.co\/alice\) \| 2 \| 3/u);
  assert.match(updated, /`pi-default`/u);
  assert.equal(syncReadmeCommunity(updated, community), updated);
});

test("contributors badge counts data contributors plus the project author", () => {
  assert.deepEqual(contributorBadgeData({ contributors: [{}, {}, {}, {}, {}] }), {
    contributors: 6,
  });
});
