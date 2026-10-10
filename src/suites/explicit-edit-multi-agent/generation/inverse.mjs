import { unpack, restoreBlankLines } from "./generator.mjs";
import { undoNames } from "./semantic-names.mjs";
import { undoFunctionMix } from "./function-mix.mjs";
import { restoreOrigin } from "./origin-markers.mjs";

/** Replay a guarded inverse from serialized records, extracting code from the supplied tree. */
export function reverseOperation(tree, record) {
  if (record.kind === "rename") return undoNames(tree, record);
  if (record.kind === "origin-markers") return restoreOrigin(tree, record);
  if (["function-declarations", "function-permutation"].includes(record.kind))
    return undoFunctionMix(tree, record);
  if (record.kind === "compact") return restoreBlankLines(tree, record);
  return unpack(tree, record);
}
