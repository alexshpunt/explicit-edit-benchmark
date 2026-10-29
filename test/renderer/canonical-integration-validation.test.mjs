import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalAssignmentPrompt,
  canonicalIntegrationNodes,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";

function pixels(scene, kind = "normal") {
  const result = Buffer.alloc(32 * 32 * 4 * 4);
  for (let pixel = 0; pixel < 32 * 32; pixel++) {
    for (let channel = 0; channel < 4; channel++) {
      const value =
        channel === 3
          ? 1
          : kind === "constant"
            ? 0
            : kind === "nonfinite" && pixel === 0 && channel === 0
              ? NaN
              : (pixel + channel + scene) % 2;
      result.writeFloatLE(value, (pixel * 4 + channel) * 4);
    }
  }
  return result;
}

function hashes(kind = "normal") {
  return [0, 1].map((scene) => createHash("sha256").update(pixels(scene, kind)).digest("hex"));
}

function main(kind = "normal") {
  return `#include <cstdio>
#include <limits>
#include <string>
float value(int pixel, int channel, int scene);
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  bool repeated = false;
  ${kind === "repeat" ? 'if (FILE *seen = std::fopen("/tmp/validation-repeat-marker", "r")) { repeated = true; std::fclose(seen); } else { FILE *marker = std::fopen("/tmp/validation-repeat-marker", "w"); if (!marker) return 2; std::fclose(marker); }' : ""}
  for (int scene = 0; scene < 2; ++scene) {
    auto name = std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f";
    FILE *file = std::fopen(name.c_str(), "wb");
    if (!file) return 3;
    for (int pixel = 0; pixel < 32 * 32; ++pixel) {
      for (int channel = 0; channel < 4; ++channel) {
        float number = channel == 3 ? 1.0f : value(pixel, channel, scene);
        ${kind === "constant" ? "if (channel != 3) number = 0.0f;" : ""}
        ${kind === "nonfinite" ? "if (pixel == 0 && channel == 0) number = std::numeric_limits<float>::quiet_NaN();" : ""}
        if (repeated && pixel == 0 && channel == 0) number = 9.0f;
        if (std::fwrite(&number, sizeof(number), 1, file) != 1) return 4;
      }
    }
    if (std::fclose(file)) return 5;
  }
  return 0;
}
`;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "canonical-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested sources"));
  await writeFile(path.join(root, "main.cpp"), main());
  await writeFile(
    path.join(root, "nested sources", "helper.cpp"),
    "float value(int pixel, int channel, int scene) { return float((pixel + channel + scene) % 2); }\n",
  );
  return root;
}

function validate(workspace, stage, expectedPixels = hashes()) {
  const node = canonicalIntegrationNodes(stage, { expectedPixels });
  assert.equal(node.length, 1);
  const data = JSON.parse(node[0].prompt);
  assert.equal(data.stage, stage);
  assert.equal(typeof data.validation, "string");
  const result = spawnSync(
    "/usr/bin/bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--new-session",
      "--die-with-parent",
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/bin",
      "/bin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/etc/ld.so.cache",
      "/etc/ld.so.cache",
      "--ro-bind-try",
      "/etc/alternatives",
      "/etc/alternatives",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      workspace,
      "/workspace",
      "--chdir",
      "/workspace",
      "/usr/bin/bash",
      "-c",
      data.validation,
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(typeof result.status, "number");
  return result;
}

test(
  "integration build validation compiles every translation unit",
  { timeout: 180000 },
  async (t) => {
    const workspace = await fixture(t);
    const success = validate(workspace, "build-correction");
    assert.equal(success.status, 0, success.stderr);
    await writeFile(path.join(workspace, "nested sources", "bad.cpp"), "this does not compile\n");
    const failure = validate(workspace, "build-correction");
    assert.notEqual(failure.status, 0);
  },
);

test(
  "integration image validation checks both scenes, repeats and pixel validity",
  { timeout: 180000 },
  async (t) => {
    const workspace = await fixture(t);
    const success = validate(workspace, "image-correction");
    assert.equal(success.status, 0, success.stderr);
    assert.notEqual(
      validate(workspace, "image-correction", [hashes()[0], "0".repeat(64)]).status,
      0,
    );
    await writeFile(path.join(workspace, "main.cpp"), main("repeat"));
    assert.notEqual(validate(workspace, "image-correction").status, 0);
    for (const kind of ["constant", "nonfinite"]) {
      await writeFile(path.join(workspace, "main.cpp"), main(kind));
      assert.notEqual(validate(workspace, "image-correction", hashes(kind)).status, 0);
    }
  },
);

test(
  "a native Pi participant receives and executes integration validation",
  { skip: !process.env.RENDERER_PI_RUNTIME || process.platform !== "linux", timeout: 180000 },
  async (t) => {
    const workspace = await fixture(t);
    const root = await mkdtemp(path.join(os.tmpdir(), "canonical-native-feedback-"));
    const provider = await providerFixture(root, (body) => {
      if (body.messages.at(-1).role === "tool") return {};
      const content = body.messages.findLast(({ role }) => role === "user").content;
      const prompt =
        typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
      const data = JSON.parse(prompt.split("\n").find((line) => line.startsWith('{"stage":')));
      const encoded = Buffer.from(data.validation).toString("base64");
      return { command: `printf '%s' '${encoded}' | base64 -d | bash && touch verified` };
    });
    t.after(async () => {
      provider.close();
      await rm(root, { recursive: true, force: true });
    });
    const driver = await startPiParticipant(
      workspace,
      path.join(root, "participant"),
      provider.config,
    );
    t.after(() => driver.terminate());
    const nodes = canonicalIntegrationNodes("image-correction", { expectedPixels: hashes() });
    await driver.execute(canonicalAssignmentPrompt(nodes), {
      completion: "turn",
      signal: t.signal,
    });
    assert.equal(provider.errors.length, 0);
    assert.ok(provider.requests.length >= 2);
    assert.ok((await stat(path.join(workspace, "verified"))).isFile());
  },
);
