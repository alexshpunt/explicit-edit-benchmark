import assert from "node:assert/strict";
import test from "node:test";
import { listOpenCommunityCandidates } from "../../scripts/community-acceptance-cli.mjs";
import { listOpenOfficialCandidates } from "../../scripts/official-acceptance.mjs";

for (const [kind, list, prefix] of [
  ["community", listOpenCommunityCandidates, "Contribute benchmark observation "],
  ["official", listOpenOfficialCandidates, "Contribute official benchmark execution "],
]) {
  test(`${String(kind)} automation leaves reopened PRs out of its queue`, async () => {
    const requests = [];
    const result = await list("owner/dataset", async (url) => {
      requests.push(url);
      const events = url.endsWith("/2")
        ? [
            { type: "status-change", data: { status: "closed" } },
            { type: "comment", data: {} },
            { type: "status-change", data: { status: "open" } },
            { type: "commit", data: { oid: "a".repeat(40) } },
          ]
        : [{ type: "status-change", data: { status: "open" } }];
      return {
        ok: true,
        json: async () =>
          url.includes("?status=open")
            ? {
                discussions: [1, 2].map((num) => ({
                  num,
                  isPullRequest: true,
                  status: "open",
                  title: prefix + "a".repeat(64),
                })),
              }
            : { events },
      };
    });
    assert.deepEqual(
      result.map((item) => item.number),
      [1],
    );
    assert.equal(requests.length, 3);
  });
}
