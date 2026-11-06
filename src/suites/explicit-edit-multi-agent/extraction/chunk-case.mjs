import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cppTokens } from "../cpp/cpp-tokens.mjs";
import { loadFlatCase } from "./flat-case.mjs";
import { flatPublicAssignments } from "./flat-assignments.mjs";
import { prepareFlatBatchProse } from "./flat-batch-prose.mjs";
import { partitionFlatTask } from "./flat-batches.mjs";
import { cleanupFlatScaffold, scaffoldFlatPlan } from "./flat-scaffold.mjs";
import { markSources, removeSourceMarkers } from "./flat-source-markers.mjs";

/** The header-only math task starts after all other tasks have finished. */
export const CHUNK_SECOND_TEAM_FILE = "frond_math.h";

/** Load a flat case and derive the marked scaffold, public prose and delivery batches. */
export async function prepareChunkCase(casePath) {
  const { plan: originalPlan, manifest } = await loadFlatCase(casePath);
  const assignments = await flatPublicAssignments(originalPlan);
  const contracts = new Map(
    originalPlan.tasks.map((task) => [task.id, assignments.get(task.id).contract]),
  );
  const scaffold = scaffoldFlatPlan(originalPlan);
  const { plan, markers: rawMarkers } = scaffold;
  const markers = new Map([...rawMarkers].map(([id, marker]) => [id, marker.trimEnd()]));
  const { tree, sourceMarkers } = markSources(plan, scaffold.tree);
  const prose = await prepareFlatBatchProse(plan, contracts);
  const batches = new Map();
  for (const task of plan.tasks)
    batches.set(
      task.id,
      await partitionFlatTask(task, {
        render: ({ fragments }) => prose.render(task, fragments, { markers, sourceMarkers }).prompt,
      }),
    );
  return {
    originalPlan,
    plan,
    manifest,
    tree,
    markers,
    rawMarkers,
    sourceMarkers,
    prose,
    batches,
  };
}

/** Remove every marker from a tree; the result is the trusted round start for scoring. */
export function cleanChunkTree(tree, { sourceMarkers, rawMarkers }) {
  const unmarked = {};
  for (const [file, content] of Object.entries(tree))
    unmarked[file] =
      typeof content === "string" ? removeSourceMarkers(content, sourceMarkers) : content;
  return { ...unmarked, ...cleanupFlatScaffold(unmarked, rawMarkers) };
}

/** Remove remaining markers from the workspace and count how many agents left behind. */
export async function cleanupChunkMarkers(workspace, { plan, markers, rawMarkers, sourceMarkers }) {
  const sourceSet = new Set(sourceMarkers.values()),
    destinationSet = new Set(markers.values());
  assert.equal(sourceSet.size, sourceMarkers.size);
  assert.equal(destinationSet.size, markers.size);
  const tree = {};
  let source = 0,
    destination = 0;
  for (const file of ["main.cpp", ...plan.tasks.map((task) => task.file)]) {
    const content = await readFile(path.join(workspace, file), "utf8");
    for (const token of cppTokens(content)) {
      if (sourceSet.has(token.text)) source++;
      if (destinationSet.has(token.text)) destination++;
    }
    tree[file] = removeSourceMarkers(content, sourceMarkers);
  }
  const cleaned = cleanupFlatScaffold(tree, rawMarkers);
  for (const [file, content] of Object.entries(cleaned))
    if (content !== (await readFile(path.join(workspace, file), "utf8")))
      await writeFile(path.join(workspace, file), content);
  return { source, destination };
}
