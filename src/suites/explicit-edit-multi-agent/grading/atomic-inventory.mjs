import { treeIdentity } from "../generation/generator.mjs";
import { prepareCoherentContract } from "./coherent-grade.mjs";

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Reuse immutable lexical records for unchanged current file bytes and paths.
 * Recompute identity on every call, including mutations of the same tree object.
 * Retain one version per current file, never history, parse failures or decisions.
 * Changed or relocated files are parsed again; deleted files are released.
 * Trusted checkpoint preparation always reads the complete supplied tree.
 * clear() drops all retained records; the reader can safely be used afterward.
 */
export function createAtomicInventory() {
  const version = prepareCoherentContract({}).version;
  let cached;
  let files = new Map();
  const read = (tree) => {
    const identity = treeIdentity(tree);
    const entries = Object.entries(tree);
    const order = JSON.stringify(entries.map(([file]) => file));
    if (cached?.identity !== identity || cached.order !== order) {
      const next = new Map();
      const obligations = [];
      for (const [file, source] of entries) {
        let entry = files.get(file);
        if (entry?.source !== source) {
          const contract = freeze(prepareCoherentContract({ [file]: source }));
          entry = { source, contract };
        }
        next.set(file, entry);
        obligations.push(...entry.contract.obligations);
      }
      const contract = Object.freeze({
        version,
        files: Object.freeze(entries.map(([file]) => file).sort()),
        obligations: Object.freeze(obligations),
      });
      files = next;
      cached = { identity, order, contract };
    }
    return cached.contract;
  };
  read.clear = () => {
    cached = undefined;
    files = new Map();
  };
  return read;
}
