import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { publishEdits } from "../../src/suites/explicit-edit-multi-agent/reference/ordinary-edit.mjs";

function publisher(root, before, after, signal, { pause = false } = {}) {
  const module = new URL(
    "../../src/suites/explicit-edit-multi-agent/reference/ordinary-edit.mjs",
    import.meta.url,
  ).href;
  const code = `
    import { publishEdits } from ${JSON.stringify(module)};
    import { readSync } from "node:fs";
    console.log("ready");
    readSync(0, Buffer.alloc(1), 0, 1, null);
    const result = publishEdits(process.argv[1], ${JSON.stringify(before)}, ${JSON.stringify(after)}, {
      onEvent(phase) {
        if (${pause} && phase === "write-start") {
          console.log("paused");
          readSync(0, Buffer.alloc(1), 0, 1, null);
        }
      }
    });
    if (result.conflicts.length) throw Error(JSON.stringify(result));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, root], {
    signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers(),
    paused = Promise.withResolvers();
  let output = "",
    error = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
    if (output.includes("ready\n")) ready.resolve();
    if (output.includes("paused\n")) paused.resolve();
  });
  child.stderr.on("data", (bytes) => {
    error += bytes;
  });
  child.stdin.on("error", () => {});
  const done = new Promise((resolve, reject) => {
    const fail = (reason) => {
      ready.reject(reason);
      paused.reject(reason);
      reject(reason);
    };
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? resolve() : fail(Error(error || `Publisher exited ${code}`)),
    );
  });
  // Cleanup can stop a deliberately paused child after an assertion fails.
  // Attach handlers now; callers still await and verify the real result.
  done.catch(() => {});
  ready.promise.catch(() => {});
  paused.promise.catch(() => {});
  return { child, ready: ready.promise, paused: paused.promise, done };
}

async function closePublishers(writers) {
  for (const { child } of writers) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.allSettled(writers.map((writer) => writer.done));
}

test("an atomic file edit protects its current read through publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atomic-publication-"));
  const before = { "main.cpp": "int first; int second;\n" };
  const after = { "main.cpp": "int renamed; int second;\n" };
  try {
    await writeFile(path.join(root, "main.cpp"), before["main.cpp"]);
    const observed = [];
    const result = publishEdits(root, before, after, {
      onEvent(phase, file) {
        if (!["read-end", "write-start"].includes(phase)) return;
        const peer = spawnSync("flock", [
          "--nonblock",
          "--exclusive",
          path.join(root, file),
          "true",
        ]);
        assert.equal(peer.error, undefined);
        observed.push({ phase, status: peer.status });
      },
    });
    assert.deepEqual(observed, [
      { phase: "read-end", status: 1 },
      { phase: "write-start", status: 1 },
    ]);
    assert.deepEqual(result, { written: ["main.cpp"], conflicts: [] });
    assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), after["main.cpp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "a paused file edit preserves a second publisher and leaves other files writable",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "two-atomic-publishers-"));
    const before = { "main.cpp": "int first; int second;\n" };
    const writers = [];
    try {
      await writeFile(path.join(root, "main.cpp"), before["main.cpp"]);
      const first = publisher(
        root,
        before,
        { "main.cpp": before["main.cpp"].replace("first", "first_changed") },
        t.signal,
        { pause: true },
      );
      writers.push(first);
      await first.ready;
      first.child.stdin.write("x");
      await first.paused;
      const guard = spawnSync("flock", [
        "--nonblock",
        "--exclusive",
        path.join(root, "main.cpp"),
        "true",
      ]);
      assert.equal(guard.status, 1);
      const second = publisher(
        root,
        before,
        { "main.cpp": before["main.cpp"].replace("second", "second_changed") },
        t.signal,
      );
      writers.push(second);
      await second.ready;
      second.child.stdin.end("x");
      // This operation would block if a publisher locked the whole workspace.
      assert.deepEqual(publishEdits(root, {}, { "peer.h": "int independent;\n" }), {
        written: ["peer.h"],
        conflicts: [],
      });
      assert.equal(await readFile(path.join(root, "peer.h"), "utf8"), "int independent;\n");
      first.child.stdin.end("x");
      await Promise.all(writers.map((writer) => writer.done));
      assert.equal(
        await readFile(path.join(root, "main.cpp"), "utf8"),
        "int first_changed; int second_changed;\n",
      );
    } finally {
      await closePublishers(writers);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "fifteen concurrent file patches retain every independent requested edit",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "fifteen-atomic-publishers-"));
    const original = Array.from({ length: 15 }, (_, i) => `int Old${i};\n`).join("");
    try {
      for (let round = 0; round < 3; round++) {
        const writers = [];
        try {
          await writeFile(path.join(root, "main.cpp"), original);
          for (let i = 0; i < 15; i++)
            writers.push(
              publisher(
                root,
                { "main.cpp": original },
                { "main.cpp": original.replace(`Old${i};`, `New${i};`) },
                t.signal,
              ),
            );
          await Promise.all(writers.map((writer) => writer.ready));
          for (const { child } of writers) child.stdin.end("x");
          await Promise.all(writers.map((writer) => writer.done));
          const expected = Array.from({ length: 15 }, (_, i) => `int New${i};\n`).join("");
          assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), expected);
        } finally {
          await closePublishers(writers);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a cross-file rename conflict leaves every file available for current-source replanning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cross-file-rename-conflict-"));
  const before = {
    "api.h": "#pragma once\nnamespace sample { inline constexpr int Old = 1; }\n",
    "main.cpp":
      '#include "api.h"\n\nint main() { return sample::Old - 1; }\n\nnamespace sample {\n\n}\n',
  };
  const after = Object.fromEntries(
    Object.entries(before).map(([file, source]) => [file, source.replaceAll("Old", "Current")]),
  );
  const cleaned = '#include "api.h"\nint main() { return sample::Old - 1; }\n';
  try {
    await writeFile(path.join(root, "api.h"), before["api.h"]);
    await writeFile(path.join(root, "main.cpp"), cleaned);
    const result = publishEdits(root, before, after);
    assert.deepEqual(result, { written: [], conflicts: ["main.cpp"] });
    assert.equal(await readFile(path.join(root, "api.h"), "utf8"), before["api.h"]);
    assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), cleaned);
    const current = { ...before, "main.cpp": cleaned };
    const replanned = Object.fromEntries(
      Object.entries(current).map(([file, source]) => [file, source.replaceAll("Old", "Current")]),
    );
    assert.deepEqual(publishEdits(root, current, replanned), {
      written: ["api.h", "main.cpp"],
      conflicts: [],
    });
    for (const [file, source] of Object.entries(replanned))
      assert.equal(await readFile(path.join(root, file), "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "cross-file publishers guard all their targets while unrelated files remain writable",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "cross-file-publishers-"));
    const before = {
      "api.h": "int first; int second;\n",
      "main.cpp": "int use() { return first + second; }\n",
    };
    const writers = [];
    try {
      for (const [file, source] of Object.entries(before))
        await writeFile(path.join(root, file), source);
      const rename = (name, next, reverse = false) =>
        Object.fromEntries(
          (reverse ? Object.entries(before).reverse() : Object.entries(before)).map(
            ([file, source]) => [file, source.replaceAll(name, next)],
          ),
        );
      const first = publisher(root, before, rename("first", "first_changed"), t.signal, {
        pause: true,
      });
      writers.push(first);
      await first.ready;
      first.child.stdin.write("x");
      await first.paused;
      for (const file of Object.keys(before))
        assert.equal(
          spawnSync("flock", ["--nonblock", "--exclusive", path.join(root, file), "true"]).status,
          1,
        );
      const second = publisher(
        root,
        Object.fromEntries(Object.entries(before).reverse()),
        rename("second", "second_changed", true),
        t.signal,
      );
      writers.push(second);
      await second.ready;
      second.child.stdin.end("x");
      assert.deepEqual(publishEdits(root, {}, { "peer.h": "int independent;\n" }), {
        written: ["peer.h"],
        conflicts: [],
      });
      first.child.stdin.end("x");
      await Promise.all(writers.map((writer) => writer.done));
      for (const [file, source] of Object.entries(before))
        assert.equal(
          await readFile(path.join(root, file), "utf8"),
          source.replaceAll("first", "first_changed").replaceAll("second", "second_changed"),
        );
    } finally {
      await closePublishers(writers);
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  "several new files share one directory guard without blocking their publisher",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "cross-file-creation-"));
    const after = { "first.h": "int first;\n", "second.h": "int second;\n" };
    const writers = [];
    try {
      const writer = publisher(root, {}, after, t.signal);
      writers.push(writer);
      await writer.ready;
      writer.child.stdin.end("x");
      await writer.done;
      for (const [file, source] of Object.entries(after))
        assert.equal(await readFile(path.join(root, file), "utf8"), source);
    } finally {
      await closePublishers(writers);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a rejected multi-file edit creates no new files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cross-file-creation-conflict-"));
  const before = { "main.cpp": "int Old;\n" };
  try {
    await writeFile(path.join(root, "main.cpp"), "int unrelated;\n");
    assert.deepEqual(
      publishEdits(root, before, { "main.cpp": "int current;\n", "api.h": "int added;\n" }),
      { written: [], conflicts: ["main.cpp"] },
    );
    await assert.rejects(readFile(path.join(root, "api.h")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), "int unrelated;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("atomic publication does not depend on the caller PATH", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atomic-empty-path-"));
  const savedPath = process.env.PATH;
  const before = { "main.cpp": "int First;\n" };
  try {
    await writeFile(path.join(root, "main.cpp"), before["main.cpp"]);
    process.env.PATH = root;
    const observed = [];
    const result = publishEdits(
      root,
      before,
      { "main.cpp": "int first;\n" },
      {
        onEvent(phase, file) {
          if (phase !== "read-end") return;
          observed.push(
            spawnSync("/usr/bin/flock", [
              "--nonblock",
              "--exclusive",
              path.join(root, file),
              "true",
            ]).status,
          );
        },
      },
    );
    assert.deepEqual(result, { written: ["main.cpp"], conflicts: [] });
    assert.deepEqual(observed, [1]);
    assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), "int first;\n");
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  }
});
