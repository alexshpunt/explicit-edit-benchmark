import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  captureCandidate,
  releaseCandidateWorkspace,
} from "../../src/suites/explicit-edit-multi-agent/execution/candidate-evidence.mjs";
import { measureCoherentCandidate } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-build.mjs";

const exec = promisify(execFile);
const pixels = [0, 1].map((scene) => {
  const bytes = Buffer.alloc(32 * 32 * 4 * 4);
  for (let i = 0; i < bytes.length / 4; i++) bytes.writeFloatLE((scene + (i % 4) + 1) / 8, i * 4);
  return createHash("sha256").update(bytes).digest("hex");
});
function program(adjustment = "0.0f", declarations = "") {
  return `#include <fstream>
#include <string>
#include <sys/stat.h>
${declarations}
int main(int argc, char** argv) {
  for (int scene = 0; scene < 2; ++scene) {
    std::ofstream output(std::string(argv[1]) + "-" + std::to_string(scene) + ".rgba32f", std::ios::binary);
    for (int i = 0; i < 32 * 32 * 4; ++i) {
      float value = (scene + i % 4 + 1) / 8.0f + ${adjustment};
      output.write(reinterpret_cast<const char*>(&value), sizeof(value));
    }
  }
}
`;
}
async function fixture(t, main = program()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "canonical-build-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  t.after(async () => {
    releaseCandidateWorkspace(workspace);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(workspace, "main.cpp"), main);
  return { root, workspace };
}
async function measure({ root, workspace }) {
  const candidate = await captureCandidate(workspace, path.join(root, "capture"), {
    includeAllFiles: true,
  });
  const result = await measureCoherentCandidate(
    candidate.source,
    path.join(root, "integration"),
    candidate.tree,
    { expectedPixels: pixels, completeInventory: true },
  );
  return { candidate, result };
}

test("canonical compilation includes an added translation unit with malformed UTF-8 bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, "broken.cpp"), Buffer.from([0xff, 0xfe, 0x0a]));
  const { candidate, result } = await measure(f);
  assert.equal(candidate.contents.size, 2);
  assert.equal(result.buildPassed, false);
  assert.equal(result.resultMatched, false);
  assert.equal(result.failure.category, "build");
});

test("canonical compilation preserves a translation unit's raw POSIX filename bytes", async (t) => {
  const f = await fixture(t, program("extra()", "float extra();"));
  const file = Buffer.concat([
    Buffer.from(f.workspace + "/"),
    Buffer.from([0xff]),
    Buffer.from(".cpp"),
  ]);
  await writeFile(file, "float extra() { return 0.0f; }\n");
  const { candidate, result } = await measure(f);
  assert.ok(candidate.manifest.entries.some(({ path: name }) => name === null));
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, true);
  assert.deepEqual(result.pixels, pixels);
});

test("canonical compilation uses a source symlink without turning its target into another translation unit", async (t) => {
  const f = await fixture(t, program("extra()", "float extra();"));
  await writeFile(path.join(f.workspace, "payload.inc"), "float extra() { return 0.0f; }\n");
  await symlink("payload.inc", path.join(f.workspace, "extra.cpp"));
  const { candidate, result } = await measure(f);
  assert.ok(candidate.manifest.entries.some(({ type }) => type === "symlink"));
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, true);
  assert.deepEqual(result.pixels, pixels);
});

for (const kind of ["fifo", "socket"]) {
  test(`canonical rendering observes the captured ${kind} entry without opening or following it`, async (t) => {
    const predicate = kind === "fifo" ? "S_ISFIFO" : "S_ISSOCK";
    const f = await fixture(
      t,
      program(
        "presence()",
        `float presence() {
  struct stat info;
  return lstat("/workspace/probe", &info) == 0 && ${predicate}(info.st_mode) ? 0.0f : 1.0f;
}`,
      ),
    );
    await exec(
      "/usr/bin/python3",
      [
        "-c",
        kind === "fifo"
          ? "import os,sys; os.mkfifo(sys.argv[1])"
          : "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()",
        path.join(f.workspace, "probe"),
      ],
      { env: {} },
    );
    const { candidate, result } = await measure(f);
    assert.ok(candidate.manifest.entries.some(({ type }) => type === "unsupported"));
    assert.equal(result.buildPassed, true);
    assert.equal(result.resultMatched, true);
    assert.deepEqual(result.pixels, pixels);
  });
}

test("canonical compilation preserves whitespace, quotes and option-like source names", async (t) => {
  const f = await fixture(t, program("extra()", "float extra();"));
  await writeFile(
    path.join(f.workspace, "-source ' quoted\n.cpp"),
    "float extra() { return 0.0f; }\n",
  );
  const { result } = await measure(f);
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, true);
  assert.deepEqual(result.pixels, pixels);
});

test("canonical source symlinks to a pipe fail without opening the pipe", async (t) => {
  const f = await fixture(t);
  await exec(
    "/usr/bin/python3",
    ["-c", "import os,sys; os.mkfifo(sys.argv[1])", path.join(f.workspace, "pipe")],
    { env: {} },
  );
  await symlink("pipe", path.join(f.workspace, "extra.cpp"));
  const { result } = await measure(f);
  assert.equal(result.buildPassed, false);
  assert.equal(result.resultMatched, false);
  assert.equal(result.failure.category, "build");
});

test("canonical special entries retain raw names beneath a long private mirror prefix", async (t) => {
  const folder = "deep-" + "x".repeat(100);
  const f = await fixture(
    t,
    program(
      "presence()",
      `float presence() {
  struct stat fifo, endpoint;
  return lstat("/workspace/${folder}/\\377-fifo", &fifo) == 0 && S_ISFIFO(fifo.st_mode) &&
    lstat("/workspace/${folder}/\\376-socket", &endpoint) == 0 && S_ISSOCK(endpoint.st_mode) ? 0.0f : 1.0f;
}`,
    ),
  );
  const nested = path.join(f.workspace, folder);
  await mkdir(nested);
  await exec(
    "/usr/bin/python3",
    [
      "-c",
      "import os,socket,sys; os.chdir(sys.argv[1]); os.mkfifo(b'\\xff-fifo'); s=socket.socket(socket.AF_UNIX); s.bind(b'\\xfe-socket'); s.close()",
      nested,
    ],
    { env: {} },
  );
  const { candidate, result } = await measure(f);
  assert.equal(
    candidate.manifest.entries.filter(
      ({ path: name, type }) => name === null && type === "unsupported",
    ).length,
    2,
  );
  assert.equal(result.buildPassed, true);
  assert.equal(result.resultMatched, true);
  assert.deepEqual(result.pixels, pixels);
});
