import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { treeIdentity } from "../generation/generator.mjs";
import { validateAtomicBindingCoupling } from "../cpp/atomic-binding-coupling.mjs";

const editKey = (edit) => JSON.stringify([edit.file, edit.start, edit.old, edit.new]);
const editSet = (plan) => plan.edits.map(editKey).sort();

function certifiedBindings(plan, certification) {
  assert.ok(certification?.operation && certification.plan, "Missing certified operation union");
  assert.equal(plan.id, certification.plan.id, "Certified operation union identity differs");
  assert.deepEqual(editSet(plan), editSet(certification.plan), "Certified operation union differs");
  const { operation, atoms } = certification;
  const groups = operation.bindingGroups;
  assert.ok(Array.isArray(groups) && groups.length, "Missing certified binding groups");
  assert.equal(operation.bindingCertification?.version, "renderer-atomic-bindings-v1");
  assert.equal(
    operation.bindingCertification.sha256,
    createHash("sha256").update(JSON.stringify(groups)).digest("hex"),
    "Certified binding selector fingerprint differs",
  );
  assert.ok(
    Array.isArray(atoms) && atoms.length === groups.length,
    "Incomplete certified bindings",
  );
  const occupied = new Set();
  const { bindingGroups: _groups, bindingCertification: _certification, ...original } = operation;
  for (const [index, atom] of atoms.entries()) {
    const group = groups[index];
    assert.ok(
      Array.isArray(group?.selectors) &&
        Number.isSafeInteger(group.bindingCount) &&
        group.bindingCount >= 1 &&
        group.bindingCount <= group.selectors.length &&
        (group.bindingCount === 1 ||
          group.selectors.every((selector) => selector.kind === "function")),
      "Invalid certified binding count",
    );
    assert.equal(atom.bindingGroup, index, "Certified binding order differs");
    validateAtomicBindingCoupling(atom, group.bindingCount);
    assert.ok(
      operation.mapping.some(
        (mapping) => mapping.from === group.mapping.from && mapping.to === group.mapping.to,
      ),
      "Certified binding mapping differs",
    );
    assert.deepEqual(
      atom.operation,
      { ...original, mapping: [group.mapping], selectors: group.selectors },
      "Certified binding public operation differs",
    );
    assert.equal(atom.plan.id, plan.id, "Certified binding plan identity differs");
    assert.ok(atom.plan.edits.length, "Empty certified binding plan");
    for (const edit of atom.plan.edits) {
      assert.equal(edit.old, group.mapping.from, "Certified binding source differs");
      assert.equal(edit.new, group.mapping.to, "Certified binding target differs");
      const key = JSON.stringify([edit.file, edit.start]);
      assert.ok(!occupied.has(key), "Overlapping certified binding edits");
      occupied.add(key);
    }
  }
  assert.deepEqual(
    editSet({ edits: atoms.flatMap((atom) => atom.plan.edits) }),
    editSet(plan),
    "Certified binding plans do not cover their union",
  );
  for (const mapping of operation.mapping)
    assert.ok(
      groups.some(
        (group) => group.mapping.from === mapping.from && group.mapping.to === mapping.to,
      ),
      "Certified bindings omit an original mapping",
    );
  return certification;
}

/** Seal compiler-selected edits against one coarse naming group's starting tree.
 * Earlier module plans share the original compiler snapshot. Rebase their length
 * changes into this group's offsets, but leave intra-group edits on that same
 * starting snapshot for applyScopedNamePlan(). Optional certifications must be
 * complete atomicPlans() results paired with the union plans in operation order.
 * Their public operations retain compiler-sealed binding counts; each private
 * plan is one delivery, including deduplicated sites of an inseparable overload
 * group. sourceOperations[0] and bindingGroup address those deliveries without
 * compiler IDs in prompts. Different deliveries must still have disjoint plans.
 * This private record must never enter prompts or editing-worker mounts.
 */
export function coherentNamingPlans(tree, plans, applied = [], certifications) {
  const earlier = applied.flatMap((plan) => plan.edits);
  const rebaseSite = (site) => ({
    ...site,
    start:
      site.start +
      earlier
        .filter((previous) => previous.file === site.file && previous.start < site.start)
        .reduce((sum, previous) => sum + previous.new.length - previous.old.length, 0),
  });
  const rebase = (plan) => ({
    id: plan.id,
    edits: plan.edits.map((edit) => {
      const { start } = rebaseSite(edit);
      assert.equal(
        tree[edit.file]?.slice(start, start + edit.old.length),
        edit.old,
        "Private naming plan does not match group source",
      );
      return { file: edit.file, start, old: edit.old, new: edit.new };
    }),
  });
  const rebased = plans.map(rebase);
  let bindings;
  if (certifications !== undefined) {
    assert.ok(
      Array.isArray(certifications) && certifications.length === plans.length,
      "Incomplete certified operation records",
    );
    bindings = certifications.map((item, index) => {
      const certified = certifiedBindings(plans[index], item);
      return {
        operation: structuredClone(certified.operation),
        atoms: certified.atoms.map((atom) => {
          const next = {
            bindingGroup: atom.bindingGroup,
            operation: structuredClone(atom.operation),
            plan: rebase(atom.plan),
            ...(atom.coupling
              ? {
                  coupling: {
                    ...structuredClone(atom.coupling),
                    // Preserve the original compiler-snapshot proof while rebasing
                    // its footprint into this coarse group's starting coordinates.
                    origin: structuredClone(atom.coupling.origin ?? atom.coupling),
                    members: atom.coupling.members.map((member) => member.map(rebaseSite)),
                    sites: atom.coupling.sites.map(rebaseSite),
                    ...(atom.coupling.instantiations
                      ? {
                          instantiations: atom.coupling.instantiations.map((item) => ({
                            ...structuredClone(item),
                            site: rebaseSite(item.site),
                            declarations: item.declarations.map(rebaseSite),
                          })),
                        }
                      : {}),
                  },
                }
              : {}),
          };
          validateAtomicBindingCoupling(
            next,
            certified.operation.bindingGroups[atom.bindingGroup].bindingCount,
          );
          return next;
        }),
      };
    });
  }
  return {
    version: bindings ? "renderer-coherent-atomic-plans-v1" : "renderer-coherent-naming-plans-v1",
    before: treeIdentity(tree),
    plans: rebased,
    ...(bindings ? { bindings } : {}),
  };
}
