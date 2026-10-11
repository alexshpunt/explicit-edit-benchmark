import { referenceRoute } from "../generation/reference-route.mjs";
import { compactBlankLines } from "../generation/generator.mjs";
import { assertNeutralSource } from "../generation/origin-markers.mjs";
import { includeDirectives } from "../cpp/cpp-tokens.mjs";

const compact = (tree) => compactBlankLines(tree).tree;

/** Prepare short project-header extraction requests and private reference states.
 * Start after layout restoration, keep every current binding spelling, and move
 * whole guarded blocks in dependency order. Conditional vendor implementations
 * and .cpp extraction are explicitly pending, never counted as completed work.
 * Reference trees belong to trusted preparation; only requests go to the agent.
 */
export function headerRestoration(payload, manifest) {
  const route = referenceRoute(payload, manifest);
  const first = route.stages.findIndex((stage) => stage.action.startsWith("extract:"));
  if (first < 1) throw new Error("Missing header extraction route");
  const initial = compact(route.stages[first - 1].tree);
  const requests = [];
  const stages = [];
  for (const stage of route.stages.slice(first)) {
    if (!stage.action.startsWith("extract:")) break;
    const file = stage.action.slice("extract:".length);
    if (!file.endsWith(".h") || file.startsWith("support/")) break;
    const source = stage.tree[file];
    const guard = /^\s*#\s*ifndef[ \t]+([A-Za-z_]\w*)[ \t]*\r?\n\s*#\s*define[ \t]+\1\b/.exec(
      source,
    )?.[1];
    if (!guard) throw new Error(`Missing project header guard: ${file}`);
    const includes = [
      ...new Set(
        includeDirectives(source)
          .filter((item) => item.quoted)
          .map((item) => item.file),
      ),
    ];
    const id = `header-${String(requests.length + 1).padStart(3, "0")}`;
    const request = {
      id,
      phase: "structure",
      group: "project-headers",
      file,
      guard,
      includes,
      dependsOn: requests.length ? [requests.at(-1).id] : [],
      prompt: `Move the complete project header block guarded by \`${guard}\` from \`main.cpp\` into \`${file}\`. Preserve its current names, declarations, inline definitions, includes and inactive code. Replace the block with an include of the new header. Restore the listed direct project includes in their given order, including those lost during packing.\nDirect project includes: ${JSON.stringify(includes)}\nDo not restore names or add comments. Keep earlier changes and leave unrelated code unchanged. The grader checks the completed batch, not this intermediate edit.`,
    };
    assertNeutralSource("header-request", JSON.stringify(request));
    const tree = compact(stage.tree);
    for (const [name, text] of Object.entries(tree)) assertNeutralSource(name, text);
    requests.push(request);
    stages.push({ id, phase: "structure", tree });
  }
  if (!requests.length) throw new Error("No supported project header extraction");
  const endpoint = stages.at(-1).tree;
  const structure = route.stages.findLast((stage) => stage.phase === "structure").tree;
  const pendingSources = Object.keys(structure)
    .filter((file) => !Object.hasOwn(endpoint, file))
    .sort();
  return { version: "renderer-header-restoration-v1", initial, requests, stages, pendingSources };
}
