import assert from "node:assert/strict";
import test from "node:test";
import {
  vendorActivationContract,
  vendorPhaseContract,
} from "../../src/suites/explicit-edit-multi-agent/extraction/vendor-contract.mjs";

function vendorTask() {
  return {
    kind: "vendor-header",
    guard: "VENDOR_GUARD",
    fragments: [
      {
        text: "#ifndef VENDOR_GUARD\n#define VENDOR_GUARD\nint first();\n#endif\n",
        prefix: "",
        suffix: "",
      },
      {
        text: "#ifdef VENDOR_IMPLEMENTATION\nint first(){return 1;}\n#endif\n",
        prefix: "\n#if 0\n",
        suffix: "\n#endif\n",
      },
      {
        text: "#ifndef VENDOR_GUARD\n#define VENDOR_GUARD\nint second();\n#endif\n",
        prefix: "\n#if 0\n",
        suffix: "\n#endif\n",
      },
      {
        text: "#ifdef VENDOR_IMPLEMENTATION\nint second(){return 2;}\n#endif\n",
        prefix: "",
        suffix: "\n",
      },
    ],
  };
}

test("vendor contract identifies both source phases and the synthetic inactive copies without exposing bodies", () => {
  const contract = vendorPhaseContract(vendorTask());
  assert.deepEqual(contract, {
    guard: "VENDOR_GUARD",
    activation: "VENDOR_IMPLEMENTATION",
    inactivePhases: ["first implementation", "second declarations"],
  });
  assert.doesNotMatch(JSON.stringify(contract), /first\(\)|second\(\)|return/);
});

test("vendor activation specifies the include after the original macro", () => {
  const task = {
    kind: "implementation",
    fragments: [{ text: "#define VENDOR_IMPLEMENTATION\n" }],
    postamble: '#include "vendor.h"\n',
    destination: '#define VENDOR_IMPLEMENTATION\n#include "vendor.h"\n',
  };
  assert.deepEqual(vendorActivationContract(task), {
    activation: "VENDOR_IMPLEMENTATION",
    include: '#include "vendor.h"',
  });
  assert.throws(() =>
    vendorActivationContract({ ...task, destination: task.postamble + task.fragments[0].text }),
  );
  assert.throws(() => vendorActivationContract({ ...task, postamble: "#include SOME_MACRO\n" }));
});

test("vendor contract refuses a different wrapper or unmatched activation condition", () => {
  const wrapper = vendorTask();
  wrapper.fragments[1].prefix = "";
  assert.throws(() => vendorPhaseContract(wrapper));
  const activation = vendorTask();
  activation.fragments[3].text = activation.fragments[3].text.replace(
    "VENDOR_IMPLEMENTATION",
    "OTHER_IMPLEMENTATION",
  );
  assert.throws(() => vendorPhaseContract(activation));
  assert.equal(vendorPhaseContract({ kind: "header" }), null);
});
