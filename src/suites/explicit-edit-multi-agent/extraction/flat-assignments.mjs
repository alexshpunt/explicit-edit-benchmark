import assert from "node:assert/strict";
import { publicExplicitAssignments } from "./public-assignments.mjs";
import { flatVendorContract } from "./flat-vendor-contract.mjs";

/** Inventories for the separately versioned flattened CPU profile. */
export async function flatPublicAssignments(plan) {
  assert.equal(plan.version, "renderer-flat-extraction-plan-v1");
  const vendor = plan.tasks.filter((task) => ["extract-018", "extract-019"].includes(task.id));
  assert.deepEqual(
    vendor.map((task) => task.id),
    ["extract-018", "extract-019"],
  );
  assert.equal(vendor[0].file, "support/stb_image/stb_image_resize.h");
  assert.equal(vendor[1].file, "support/stb.cpp");
  const assignments = await publicExplicitAssignments({
    ...plan,
    tasks: plan.tasks.filter((task) => !vendor.includes(task)),
  });
  for (const task of vendor) {
    const contract = await flatVendorContract(
      task.destination,
      task === vendor[0] ? "header" : "implementation",
    );
    const entities = contract.entities.map(({ count, ...entity }) => ({
      ...entity,
      ...(count > 1 ? { occurrences: count } : {}),
    }));
    assignments.set(task.id, { entities, contract: { flatVendor: contract }, hints: [] });
  }
  return assignments;
}

export function flatVendorInstructions(contract) {
  assert.equal(contract.version, "flat-vendor-contract-v1");
  assert.ok(["header", "implementation"].includes(contract.role));
  const items = contract.directives.map((item, index) => {
    let description;
    switch (item.kind) {
      case "pragma-once": {
        description = "#pragma once";
        break;
      }
      case "include": {
        description = `#include ${item.name}`;
        break;
      }
      case "macro": {
        description = `the original definition of macro ${item.name}`;
        break;
      }
      case "undef": {
        description = `#undef ${item.name}`;
        break;
      }
      default: {
        throw new Error("Unsupported flat vendor directive");
      }
    }
    const location = item.inside ? ` inside ${item.inside.signature}` : " at file scope";
    return `${index + 1}. ${description}${location}.`;
  });
  return [
    "This CPU profile contains only active vendor declarations and implementation. Do not recreate inactive copies or conditional wrappers.",
    "The destination requires these directives in order. The pragma-once or include named in the destination preamble is scaffolding; preserve the other macros and their exact original replacement text from the shared source. Directives marked inside a function stay inside that function:",
    ...items,
  ].join("\n");
}
