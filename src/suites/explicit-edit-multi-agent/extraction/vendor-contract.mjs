import assert from "node:assert/strict";
import { cppStructure } from "../cpp/cpp-structure.mjs";

/** Describe a vendor activation unit without exposing its source fragments. */
export function vendorActivationContract(task) {
  assert.equal(task.kind, "implementation");
  assert.ok(Array.isArray(task.fragments) && task.fragments.length > 0);
  const source = task.fragments.map((fragment) => fragment.text).join("");
  const match = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*$/.exec(source);
  assert.ok(match, "Unsupported vendor activation macro");
  const include = /^\s*(#\s*include\s+"[^"\r\n]+")\s*$/.exec(task.postamble);
  assert.ok(include, "Unsupported vendor activation include");
  assert.equal(task.destination, source + task.postamble, "Unsupported vendor activation layout");
  return { activation: match[1], include: include[1] };
}

export function vendorActivationInstructions({ activation, include }) {
  return `Move the original #define ${activation} into this implementation file, then place ${include} after that definition. Keep the activation macro definition before the include.`;
}

/** State the synthetic wrappers as prose; the actual source remains in the workspace. */
export function vendorPhaseInstructions({ guard, activation }) {
  return `The shared source contains two copies of the vendor file. Each copy has a declaration phase guarded by #ifndef ${guard} and an implementation phase guarded by #ifdef ${activation}. The activation macro definition lies between the two copies. Keep both complete copies. In the destination, use the declaration phase from the first copy, then its implementation phase inside a new #if 0 block. Follow these with the second copy's declaration phase inside a separate new #if 0 block, then its implementation phase without that extra wrapper. Preserve the existing conditions and code within each phase.`;
}

export function vendorPhaseContract(task) {
  if (task.kind !== "vendor-header") return null;
  assert.match(task.guard, /^[A-Za-z_]\w*$/);
  assert.equal(task.fragments.length, 4);
  const conditions = task.fragments.map((fragment) => {
    const parsed = cppStructure(fragment.text);
    assert.equal(parsed.units.length, 1);
    assert.equal(parsed.units[0].kind, "conditional");
    return parsed.units[0].condition.trim();
  });
  const guard = new RegExp(`^#\\s*ifndef\\s+${task.guard}\\s*$`);
  assert.match(conditions[0], guard);
  assert.match(conditions[2], guard);
  const activation = /^#\s*ifdef\s+([A-Za-z_]\w*)\s*$/.exec(conditions[1]);
  assert.ok(activation);
  assert.match(conditions[3], new RegExp(`^#\\s*ifdef\\s+${activation[1]}\\s*$`));
  for (const [index, fragment] of task.fragments.entries()) {
    const inactive = index === 1 || index === 2;
    assert.equal(fragment.prefix.trim(), inactive ? "#if 0" : "");
    assert.equal(fragment.suffix.trim(), inactive ? "#endif" : "");
  }
  return {
    guard: task.guard,
    activation: activation[1],
    inactivePhases: ["first implementation", "second declarations"],
  };
}
