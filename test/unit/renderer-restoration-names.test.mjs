import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  pack,
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { renameCategory } from "../../src/suites/explicit-edit-multi-agent/generation/semantic-names.mjs";
import {
  maskOrigin,
  neutralFiles,
} from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import {
  referenceNameSteps,
  referenceRoute,
} from "../../src/suites/explicit-edit-multi-agent/generation/reference-route.mjs";
import { restorationNameRequests } from "../../src/suites/explicit-edit-multi-agent/tasks/restoration-requests.mjs";
import { applyRequest } from "../../src/suites/explicit-edit-multi-agent/reference/scripted-worker.mjs";
import { restorationTargets } from "../../src/suites/explicit-edit-multi-agent/tasks/restoration-targets.mjs";
import { prepareNameOwners } from "../../src/suites/explicit-edit-multi-agent/tasks/prepare-name-owners.mjs";
import {
  scopedNamingPlan,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";

await test(
  "atomic name reference steps restore bound owners after extraction without changing another owner or literals",
  { timeout: 180_000 },
  async () => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/atomic-name-reference-"));
    try {
      const original = {
        "main.cpp":
          '#include "yocto_math.h"\nint main() { return yocto::measure(yocto::Item{4,1}, 2) == 7 ? 0 : 1; }\n',
        "yocto_math.h":
          "#ifndef _YOCTO_MATH_H_\n#define _YOCTO_MATH_H_\nnamespace yocto { struct Item { int width; int height; }; int measure(Item item, int width); }\n#endif\n",
        "yocto_shape.cpp":
          '#include "yocto_math.h"\nnamespace yocto { static int split_middle(int value) { return value; } int measure(Item item, int width) { const char* note = "width height Item measure"; { int width = 0; item.width += width; } return split_middle(item.width + item.height + width) + 0 * note[0]; } }\n',
      };
      const operations = [];
      let current = original;
      for (const operation of [
        {
          kind: "append",
          source: "yocto_shape.cpp",
          target: "main.cpp",
          renames: { split_middle: "shape_split_middle" },
        },
        { kind: "include", source: "yocto_math.h", target: "main.cpp" },
      ]) {
        const result = pack(current, operation);
        current = result.tree;
        operations.push(result.record);
      }
      for (const category of ["functions-types", "fields", "locals-parameters"]) {
        const result = await renameCategory(current, category, path.join(root, category));
        current = result.tree;
        operations.push(result.record);
      }
      const masked = maskOrigin(current, { name: "frond" });
      current = masked.tree;
      operations.push(masked.record);
      const manifest = {
        initial: treeIdentity(original),
        final: treeIdentity(current),
        operations,
      };
      const targets = restorationTargets(manifest);
      const requests = restorationNameRequests(manifest);
      const selectOwners = await prepareNameOwners(current, manifest, path.join(root, "owners"));
      const selectedRequests = restorationNameRequests(manifest, { selectOwners });
      assert.deepEqual(requests, restorationNameRequests(structuredClone(manifest)));
      assert.equal(requests.length, targets.naming.length + targets.helpers.length);
      assert.doesNotMatch(
        JSON.stringify(requests.map((request) => request.prompt)),
        /yocto|@\d+|selection|afterStart/i,
      );
      let working = referenceRoute(current, manifest).stages.findLast(
        (stage) => stage.phase === "structure",
      ).tree;
      let selectedWorking = working;
      const iterator = referenceNameSteps(current, manifest);
      let previous = null;
      const seen = [];
      for (const state of iterator) {
        assert.equal(state.phase, "names");
        assert.ok(state.target);
        const request = requests[seen.length];
        assert.equal(request.target, state.target);
        assert.equal(request.phase, "names");
        working = applyRequest(working, request.prompt);
        const analysis = path.join(root, `selected-${seen.length}`);
        await mkdir(analysis);
        const plans = await scopedNamingPlan(
          selectedWorking,
          [selectedRequests[seen.length]],
          analysis,
        );
        selectedWorking = applyScopedNamePlan(selectedWorking, plans[0]);
        assert.deepEqual(
          selectedWorking,
          state.tree,
          "Prepared public owners must reproduce every bound reference edit",
        );
        assert.deepEqual(
          working,
          state.tree,
          "An ordinary current-request edit must reproduce the bound reference step",
        );
        assert.deepEqual(Object.keys(state.tree).sort(), [
          "frond_math.h",
          "frond_shape.cpp",
          "main.cpp",
        ]);
        assert.match(state.tree["frond_shape.cpp"], /"width height Item measure"/);
        if (previous) assert.notEqual(treeIdentity(state.tree), treeIdentity(previous));
        const folder = path.join(root, state.target);
        await writeTree(folder, state.tree);
        const executable = path.join(folder, "program");
        execFileSync("clang++", [
          "-std=c++17",
          path.join(folder, "main.cpp"),
          path.join(folder, "frond_shape.cpp"),
          "-o",
          executable,
        ]);
        execFileSync(executable);
        previous = state.tree;
        seen.push(state.target);
      }
      assert.deepEqual(seen, [
        ...targets.naming.map((group) => group.id),
        ...targets.helpers.map((_, index) => `helper-${index + 1}`),
      ]);
      const expected = neutralFiles(
        Object.fromEntries(
          Object.entries(original).map(([file, source]) => [
            file,
            maskOrigin({ "main.cpp": source }, { name: "frond" }).tree["main.cpp"],
          ]),
        ),
        "frond",
      );
      assert.deepEqual(previous, expected);
      const bad = structuredClone(manifest);
      delete bad.operations.find((record) => record.kind === "rename").edits[0].families;
      assert.throws(() => [...referenceNameSteps(current, bad)], /binding coverage/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

await test(
  "prepared template owners retain written signatures through forward instantiations and nested records",
  { timeout: 180_000 },
  async () => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/prepared-template-owners-"));
    try {
      const original = {
        "main.cpp":
          '#include "yocto_math.h"\nint main() { return yocto::measure<int>(2) + yocto::measure(3) == 8 ? 0 : 1; }\n',
        "yocto_math.h": `#ifndef _YOCTO_MATH_H_
#define _YOCTO_MATH_H_
namespace yocto {
template <class T> auto measure(T arg);
template <class T> auto measure(T arg) {
  struct Local { int bias = 1; int operator()(int nested) const { return nested + bias; } };
  return Local{}(arg);
}
inline int measure(int arg) { return arg + 2; }
}
#endif
`,
      };
      const packed = pack(original, {
        kind: "include",
        source: "yocto_math.h",
        target: "main.cpp",
      });
      let current = packed.tree;
      const operations = [packed.record];
      for (const category of ["functions-types", "fields", "locals-parameters"]) {
        const renamed = await renameCategory(current, category, path.join(root, category));
        current = renamed.tree;
        operations.push(renamed.record);
      }
      const masked = maskOrigin(current, { name: "frond" });
      current = masked.tree;
      operations.push(masked.record);
      const manifest = {
        initial: treeIdentity(original),
        final: treeIdentity(current),
        operations,
      };
      const selectOwners = await prepareNameOwners(current, manifest, path.join(root, "owners"));
      const requests = restorationNameRequests(manifest, { selectOwners });
      let working = referenceRoute(current, manifest).stages.findLast(
        (stage) => stage.phase === "structure",
      ).tree;
      let index = 0;
      for (const state of referenceNameSteps(current, manifest)) {
        const analysis = path.join(root, `selected-${index}`);
        await mkdir(analysis);
        const plans = await scopedNamingPlan(working, [requests[index++]], analysis);
        working = applyScopedNamePlan(working, plans[0]);
        assert.deepEqual(
          working,
          state.tree,
          "Prepared owners must include written template bodies, not just prototypes",
        );
      }
      assert.equal(index, requests.length);
      await writeTree(path.join(root, "workspace"), working);
      execFileSync("clang++", [
        "-std=c++17",
        path.join(root, "workspace/main.cpp"),
        "-o",
        path.join(root, "program"),
      ]);
      execFileSync(path.join(root, "program"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
