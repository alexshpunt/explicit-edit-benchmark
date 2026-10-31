import assert from "node:assert/strict";
import test from "node:test";
import { coherentTaskPrompt } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";

test("original task rendering retains exact source selectors and directive text without JSON escaping", () => {
  const operations = [
    {
      action: "implementation",
      file: "fixture_module.cpp",
      includes: [
        { file: "fixture_public.h", quoted: true },
        { file: "fixture_system", quoted: false },
      ],
      preamble: '#if defined(FIXTURE_FEATURE)\n#include "fixture_private.h"\n#endif\n',
      targets: [
        {
          selector: {
            kind: "function",
            scope: "fixture_ns",
            declarator: "int fixture_move(const char* label)",
            definition: true,
            occurrence: 2,
            name: "fixture_move",
            signature: "int (const char *)",
          },
          context: ["using fixture_ns::fixture_value;"],
          after: { scope: "fixture_ns", declarator: "int fixture_before()", definition: true },
          before: { scope: "fixture_ns", declarator: "int fixture_after()", definition: true },
        },
      ],
    },
  ];
  const original = structuredClone(operations);
  const prompt = coherentTaskPrompt("fixture_goal", operations);
  for (const value of [
    "fixture_goal",
    "fixture_module.cpp",
    '#include "fixture_public.h"',
    "#include <fixture_system>",
    operations[0].preamble,
    "fixture_ns",
    "int fixture_move(const char* label)",
    "int (const char *)",
    "using fixture_ns::fixture_value;",
    "int fixture_before()",
    "int fixture_after()",
  ])
    assert.ok(prompt.includes(value), value);
  assert.deepEqual(operations, original);
});

test("all rename values retain their complete owners, signatures and paired destinations", () => {
  const operations = [
    {
      phase: "names",
      file: "fixture_names.h",
      mapping: [
        { from: "fixture_old", to: "fixture_new" },
        { from: "fixture_second", to: "fixture_target" },
      ],
      selectors: [
        {
          kind: "variable",
          scope: "fixture_ns::fixture_owner::fixture_old",
          owner: {
            scope: "fixture_ns::fixture_owner",
            signature: "int (double)",
            definition: false,
          },
        },
        { kind: "record", scope: "fixture_ns::fixture_record" },
      ],
    },
  ];
  const prompt = coherentTaskPrompt("fixture_naming_goal", operations);
  for (const value of [
    "fixture_names.h",
    "fixture_old",
    "fixture_new",
    "fixture_second",
    "fixture_target",
    "fixture_ns::fixture_owner::fixture_old",
    "fixture_ns::fixture_owner",
    "int (double)",
    "fixture_ns::fixture_record",
  ])
    assert.ok(prompt.includes(value), value);
});

test("header, vendor and cleanup instructions retain requested code and every include", () => {
  const operations = [
    {
      action: "header",
      guard: "FIXTURE_HEADER_GUARD",
      file: "fixture_header.h",
      includes: ["fixture_dependency.h"],
    },
    {
      action: "vendor-header",
      guard: "FIXTURE_VENDOR_GUARD",
      macro: "FIXTURE_VENDOR_IMPL",
      file: "support/stb_image/stb_image_resize.h",
      declarationsCopy: 1,
      implementationCopy: 2,
    },
    { action: "vendor-implementation", macro: "FIXTURE_VENDOR_IMPL", file: "support/stb.cpp" },
    {
      action: "remove-generated-declaration",
      file: "fixture_header.h",
      selector: { scope: "fixture_ns", declarator: "int fixture_temporary()", definition: false },
    },
    {
      action: "cleanup-empty-namespaces",
      preambleSelectors: [
        {
          condition: "#ifdef FIXTURE_CLEANUP",
          includes: [{ file: "fixture_cleanup.h", quoted: true }],
        },
      ],
      includes: [{ file: "fixture_keep.h", quoted: true }],
    },
  ];
  const prompt = coherentTaskPrompt("fixture_structure_goal", operations);
  for (const value of [
    "FIXTURE_HEADER_GUARD",
    "fixture_header.h",
    '#include "fixture_dependency.h"',
    "FIXTURE_VENDOR_GUARD",
    "FIXTURE_VENDOR_IMPL",
    "support/stb_image/stb_image_resize.h",
    '#include "stb_image/stb_image_resize.h"',
    "support/stb.cpp",
    "int fixture_temporary()",
    "#ifdef FIXTURE_CLEANUP",
    '#include "fixture_cleanup.h"',
    '#include "fixture_keep.h"',
  ])
    assert.ok(prompt.includes(value), value);
});

test("unsupported original operations fail rather than falling back to serialized records", () => {
  assert.throws(() => coherentTaskPrompt("fixture_goal", [{ action: "fixture_unknown" }]));
});
