import {
  pack,
  compactBlankLines,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { maskOrigin } from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";

export function pairedExtractionFixture({ main, headerA, headerB } = {}) {
  const original = {
    "main.cpp": main ?? '#include "yocto_a.h"\n#include "yocto_b.h"\nint main() { return 0; }\n',
    "yocto_math.h":
      "#ifndef MATH_H\n#define MATH_H\nnamespace yocto { inline int identity(int value) { return value; } }\n#endif\n",
    "yocto_a.h":
      headerA ??
      '#ifndef A_H\n#define A_H\n#include "yocto_math.h"\nnamespace yocto { int operation_a(); }\n#endif\n',
    "yocto_b.h":
      headerB ?? "#ifndef B_H\n#define B_H\nnamespace yocto { int operation_b(); }\n#endif\n",
    "yocto_a.cpp":
      '#include "yocto_a.h"\n#include <vector>\nnamespace yocto {\nusing std::vector;\nint operation_a() { return identity(1); }\n}\n',
    "yocto_b.cpp": '#include "yocto_b.h"\nnamespace yocto { int operation_b() { return 2; } }\n',
  };
  let tree = original;
  const operations = [];
  for (const [kind, source] of [
    ["append", "yocto_a.cpp"],
    ["append", "yocto_b.cpp"],
    ["include", "yocto_a.h"],
    ["include", "yocto_b.h"],
    ["include", "yocto_math.h"],
  ]) {
    const result = pack(tree, { kind, source, target: "main.cpp" });
    tree = result.tree;
    operations.push(result.record);
  }
  for (const result of [maskOrigin(tree, { name: "frond" })]) {
    tree = result.tree;
    operations.push(result.record);
  }
  const compact = compactBlankLines(tree);
  tree = compact.tree;
  operations.push(compact.record);
  return {
    initial: tree,
    headers: [
      { file: "frond_a.h", guard: "A_H", includes: ["frond_math.h"] },
      { file: "frond_b.h", guard: "B_H", includes: [] },
      { file: "frond_math.h", guard: "MATH_H", includes: [] },
    ],
    generation: {
      manifest: { initial: treeIdentity(original), final: treeIdentity(tree), operations },
      mixing: null,
    },
  };
}
