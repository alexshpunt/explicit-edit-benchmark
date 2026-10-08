#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- benchmark-community:start -->";
const END = "<!-- benchmark-community:end -->";
const EXPLORER = "https://huggingface.co/spaces/alexshpunt/benchmark-explorer";
const DEFAULT_COMMUNITY =
  "https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/community.json";
const DEFAULT_BADGES = path.resolve("badges.json");

/** Public badge counts that combine Dataset contributors with the project author. */
export function contributorBadgeData(community) {
  return { contributors: (community.contributors ?? []).length + 1 };
}

/** Render the README sections shared with the generated Dataset card. */
export function renderReadmeCommunity(community) {
  const contributors = community.contributors ?? [];
  const harnesses = community.harnesses ?? [];
  return [
    START,
    "",
    "## Data contributors",
    "",
    "Thank you to everyone who shares benchmark observations. Your work makes this public comparison possible.",
    "",
    ...(contributors.length
      ? [
          "| Contributor | Accepted runs | Configurations |",
          "| --- | ---: | ---: |",
          ...contributors.map(
            (row) =>
              `| [@${row.accountId}](${row.profileUrl}) | ${row.acceptedRuns} | ${row.configurations} |`,
          ),
        ]
      : [
          "_No confirmed contributor accounts have been published in the current Dataset projection yet._",
        ]),
    "",
    "## Accepted harnesses",
    "",
    "| Harness | Accepted runs | Configurations |",
    "| --- | ---: | ---: |",
    ...harnesses.map(
      (row) =>
        `| [\`${row.harnessFamily}\`](${EXPLORER}?card=harness%3A${encodeURIComponent(row.harnessFamily)}%40latest) | ${row.acceptedRuns} | ${row.configurations} |`,
    ),
    END,
  ].join("\n");
}

/** Replace only the generated community block and preserve the rest of the README. */
export function syncReadmeCommunity(readme, community) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start)
    throw Error("README community markers are missing");
  return `${readme.slice(0, start)}${renderReadmeCommunity(community)}${readme.slice(end + END.length)}`;
}

async function main() {
  const readmeFile = path.resolve(process.argv[2] ?? "README.md");
  const communityUrl = process.argv[3] ?? DEFAULT_COMMUNITY;
  const badgesFile = path.resolve(process.argv[4] ?? DEFAULT_BADGES);
  const response = await fetch(communityUrl);
  if (!response.ok) throw Error(`Community projection download failed (${response.status})`);
  const community = await response.json();
  const current = await readFile(readmeFile, "utf8");
  const next = syncReadmeCommunity(current, community);
  if (next !== current) await writeFile(readmeFile, next);
  await writeFile(badgesFile, `${JSON.stringify(contributorBadgeData(community), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
