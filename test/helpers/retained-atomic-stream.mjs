import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { prepareBarrierSymbolMap } from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import {
  barrierRepairNodes,
  taskDiagnostics,
} from "../../src/suites/explicit-edit-multi-agent/grading/repair-diagnostics.mjs";
import { MULTI_AGENT_MAX_ATTEMPTS } from "../../src/suites/explicit-edit-multi-agent/results.mjs";

/** Tiny retained-source integration helper. It reads and grades only after every
 * participant queue drains. Failed barrier requests are redistributed by file;
 * harness receipts never grant edit credit.
 */
export async function runRetainedAtomicStream(nodes, { evaluate, readSource, ...options }) {
  let selected = nodes,
    rotation = 0,
    result;
  for (let attempt = 1; attempt <= MULTI_AGENT_MAX_ATTEMPTS; attempt++) {
    result = await runAtomicStream(selected, {
      ...options,
      rotation,
      execute: options.execute,
    });
    rotation = result.rotation;
    const tree = await readSource();
    const barrier = await evaluate(tree);
    if (barrier.status === "pass") return { ...result, status: "pass", attempts: attempt };
    if (attempt === MULTI_AGENT_MAX_ATTEMPTS) break;
    let bindings = barrier.bindings ?? [];
    if (
      !bindings.length &&
      nodes.some((node) => node.operations.some((op) => op.phase === "names"))
    ) {
      // These tiny naming fixtures keep source compiler-valid. Current-source
      // compiler facts diagnose lost edits; original task replay is not a repair.
      await mkdir(".tmp", { recursive: true });
      const evidence = await mkdtemp(path.resolve(".tmp/retained-symbol-facts-"));
      try {
        bindings =
          (
            await prepareBarrierSymbolMap(tree, {
              evidence: path.join(evidence, "candidate"),
              signal: options.signal,
            })
          ).bindings ?? [];
      } finally {
        await rm(evidence, { recursive: true, force: true });
      }
    }
    const repairs = barrierRepairNodes({
      category: "structure",
      diagnostics: taskDiagnostics(barrier),
      nodes,
      tree,
      bindings,
    });
    const prefix = `repair-retained-attempt-${attempt + 1}-`;
    selected = repairs.map((node) => ({
      ...node,
      id: prefix + node.id,
      dependencies: node.dependencies.map((id) => prefix + id),
    }));
  }
  return { ...result, status: "blocked", attempts: MULTI_AGENT_MAX_ATTEMPTS };
}
