import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { modelExtractionDrivers } from "../../src/suites/explicit-edit-multi-agent/extraction/case.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_RUNTIME;
test(
  "real participant receives only public symbol assignments during original and recovery deliveries",
  { skip: process.platform !== "linux" || !runtime, timeout: 60000 },
  async () => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/symbol-pi-"));
    let provider, drivers, driver;
    try {
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      await writeFile(path.join(workspace, "main.cpp"), "int value;\n");
      provider = await providerFixture(root, () => ({}));
      const task = {
        id: "task-1",
        file: "shape.h",
        kind: "header",
        fragments: [{ text: "PRIVATE_BODY_829", start: 913 }],
        destination: "PRIVATE_TEMPLATE_829",
        replacement: "PRIVATE_POSITION_829",
      };
      const spec = [
        { scope: "frond", kind: "function", signature: "int shade(float value)" },
        { scope: "frond", kind: "using", signature: "using scalar = float;" },
      ];
      const output = path.join(root, "out");
      drivers = modelExtractionDrivers(output, provider.config, {
        workspace,
        publicAssignments: new Map([[task.id, spec]]),
      });
      driver = await drivers.createDriver(0, 0, {});
      await drivers.execute(driver, task, { session: 0 });
      await drivers.execute(
        driver,
        {
          id: "repair-shared",
          kind: "main-recovery",
          file: "main.cpp",
          assignments: [task],
          initialSources: { "main.cpp": "PRIVATE_INITIAL_829" },
          recovery: {
            diagnostics: [{ line: 913, column: 26, message: "PRIVATE_DIAGNOSTIC_829" }],
            verified: { sourceMatched: true, targetMatched: false },
          },
        },
        { session: 0 },
      );
      await driver.close();
      await drivers.cleanup();
      const feedback = path.join(output, "feedback/session-0");
      const original = await readFile(path.join(feedback, "module.txt"), "utf8");
      const recovery = await readFile(path.join(feedback, "module-2.txt"), "utf8");
      const recoveryAssignment = await readFile(
        path.join(feedback, "delivery-2/assignments/task-1.txt"),
        "utf8",
      );
      for (const text of [original, recovery, recoveryAssignment])
        for (const secret of [
          "PRIVATE_BODY_829",
          "PRIVATE_TEMPLATE_829",
          "PRIVATE_POSITION_829",
          "PRIVATE_INITIAL_829",
          "PRIVATE_DIAGNOSTIC_829",
          "913",
        ])
          assert.ok(!text.includes(secret));
      for (const text of [original, recovery, recoveryAssignment])
        assert.doesNotMatch(
          text,
          /"(?:scope|kind|signature|members|action|occurrences|sourceMatched|targetMatched)"\s*:/,
        );
      assert.ok(original.includes("int shade(float value)"));
      assert.ok(recoveryAssignment.includes("using scalar = float;"));
      const userMessages = provider.requests.flatMap(({ messages }) =>
        messages
          .filter(({ role }) => role === "user")
          .flatMap(({ content }) =>
            typeof content === "string"
              ? [content]
              : content.filter(({ type }) => type === "text").map(({ text }) => text),
          ),
      );
      assert.ok(userMessages.some((text) => text.includes("int shade(float value)")));
      for (const text of userMessages)
        assert.doesNotMatch(
          text,
          /"(?:scope|kind|signature|members|action|occurrences|sourceMatched|targetMatched)"\s*:/,
        );
      const delivered = JSON.stringify(provider.requests.map(({ messages }) => messages));
      for (const secret of [
        "PRIVATE_BODY_829",
        "PRIVATE_TEMPLATE_829",
        "PRIVATE_POSITION_829",
        "PRIVATE_INITIAL_829",
        "PRIVATE_DIAGNOSTIC_829",
        "913",
      ])
        assert.ok(!delivered.includes(secret));
      await assert.rejects(access(path.join(feedback, "delivery-2/initial")), { code: "ENOENT" });
    } finally {
      if (driver && !driver.closed) await driver.close();
      if (drivers) await drivers.cleanup();
      if (provider) provider.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
