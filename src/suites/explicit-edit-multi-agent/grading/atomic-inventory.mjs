import { treeIdentity } from "../generation/generator.mjs";
import { prepareCoherentContract } from "./coherent-grade.mjs";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Reuse one immutable lexical inventory for exactly matching source bytes/paths.
 * Recompute identity on every call, including mutations of the same tree object.
 * Retain no history, parse failures or grading decisions. The controller must
 * still stabilize live observations and evaluate each gate against its current
 * expected frontier; this reader cannot grant completion or dependency readiness.
 * clear() drops retained records; the same reader can safely be used afterward.
 */
export function createAtomicInventory() {
  let cached;
  const read = (tree) => {
    const identity = treeIdentity(tree);
    if (cached?.identity !== identity) {
      const contract = freeze(prepareCoherentContract(tree));
      cached = { identity, contract };
    }
    return cached.contract;
  };
  read.clear = () => {
    cached = undefined;
  };
  return read;
}
