import assert from "node:assert/strict";
import { conditionalBlockContracts } from "./conditional-contract.mjs";
import { includeContract } from "./include-contract.mjs";
import { preambleContract } from "./preamble-contract.mjs";
import { vendorActivationContract, vendorPhaseContract } from "./vendor-contract.mjs";

/** Derive file obligations and reject layouts that cannot be expressed safely. */
export async function explicitFileContract(
  task,
  { anchoredFragments = new Set(), anchoredMacros = new Set(), disambiguated = new Set() } = {},
) {
  assert.ok(
    task.fragments.every(
      (fragment) =>
        (!fragment.beforeFragment && !fragment.afterFragment) || anchoredFragments.has(fragment.id),
    ),
    "An ambiguous source fragment requires a verified public anchor",
  );
  if (task.kind === "vendor-header") return { vendor: vendorPhaseContract(task) };
  if (task.postamble) return { vendorActivation: vendorActivationContract(task) };
  assert.equal(typeof task.preamble, "string");
  assert.ok(task.destination.startsWith(task.preamble), "Unsupported preamble layout");
  const preamble = preambleContract(task.preamble, { anchoredMacros });
  const includes = includeContract(task);
  assert.equal(
    includes.length,
    preamble.filter((entry) => entry.kind === "include").length,
    "Includes outside the preamble are unsupported",
  );
  return {
    preamble,
    conditionals: await conditionalBlockContracts(task, { anchoredMacros, disambiguated }),
  };
}
