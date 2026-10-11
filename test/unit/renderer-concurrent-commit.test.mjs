import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  commitSnapshot,
  readSharedSource,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-commit.mjs";

await mkdir(".tmp", { recursive: true });
const modulePath = fileURLToPath(
  new URL(
    "../../src/suites/explicit-edit-multi-agent/reference/concurrent-commit.mjs",
    import.meta.url,
  ),
);

test(
  "four real processes reject stale snapshots and keep all peer edits in the same file",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(path.resolve(".tmp/concurrent-commit-"));
    const children = [];
    try {
      await writeFile(path.join(root, "main.cpp"), "int one; int two; int three; int four;\n");
      for (const [index, name] of ["one", "two", "three", "four"].entries()) {
        const script = `import {readSharedSource, commitSnapshot} from ${JSON.stringify(modulePath)};
import {writeFile, access} from 'node:fs/promises'; import {setTimeout as delay} from 'node:timers/promises';
const root=${JSON.stringify(root)}, name=${JSON.stringify(name)}; let before=await readSharedSource(root); let conflicts=0;
await writeFile(root+'/ready-${index}', 'ready');
while(true) { try {await access(root+'/go'); break;} catch {await delay(5);} }
while(true) {const after={'main.cpp':before['main.cpp'].replace('int '+name+';', 'int '+name+'_restored;')};
if(await commitSnapshot(root,before,after)) break; conflicts++; before=await readSharedSource(root);}
await writeFile(root+'/result-${index}', String(conflicts));`;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
        const done = new Promise((resolve, reject) => {
          let stderr = "";
          child.stderr.on("data", (bytes) => {
            stderr += bytes;
          });
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(Error(stderr))));
        });
        children.push({ child, done });
      }
      for (let index = 0; index < 4; index++)
        for (;;) {
          try {
            await access(path.join(root, `ready-${index}`));
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await delay(5);
          }
        }
      await writeFile(path.join(root, "go"), "go");
      await Promise.all(children.map((item) => item.done));
      assert.equal(
        await readFile(path.join(root, "main.cpp"), "utf8"),
        "int one_restored; int two_restored; int three_restored; int four_restored;\n",
      );
      const conflicts = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          readFile(path.join(root, `result-${index}`), "utf8"),
        ),
      );
      assert.ok(conflicts.map(Number).reduce((sum, value) => sum + value, 0) >= 3);
      assert.deepEqual(Object.keys(await readSharedSource(root)), ["main.cpp"]);
      await assert.rejects(access(path.join(root, ".renderer-edit-lock")), { code: "ENOENT" });
    } finally {
      for (const { child } of children) child.kill("SIGKILL");
      await Promise.allSettled(children.map((item) => item.done));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("source reads tolerate disappearing empty compiler controls but reject data hidden inside them", async () => {
  const root = await mkdtemp(path.resolve(".tmp/concurrent-controls-"));
  const directory = path.join(root, ".renderer-planner-0");
  const expected = { "main.cpp": "int retained;\n" };
  try {
    await writeFile(path.join(root, "main.cpp"), expected["main.cpp"]);
    const churn = (async () => {
      for (let i = 0; i < 100; i++) {
        await mkdir(directory);
        await delay(1);
        await rm(directory, { recursive: true });
      }
    })();
    const reading = (async () => {
      for (let i = 0; i < 200; i++) assert.deepEqual(await readSharedSource(root), expected);
    })();
    const results = await Promise.allSettled([churn, reading]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    await mkdir(directory);
    await writeFile(path.join(directory, "hidden.cpp"), "int hidden;\n");
    await assert.rejects(readSharedSource(root), /Nonempty reference control directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled lock wait never deletes another writer's lock or changes its source", async () => {
  const root = await mkdtemp(path.resolve(".tmp/concurrent-cancel-"));
  try {
    await writeFile(path.join(root, "main.cpp"), "int original;\n");
    await mkdir(path.join(root, ".renderer-edit-lock"));
    const before = await readSharedSource(root);
    await assert.rejects(
      commitSnapshot(
        root,
        before,
        { "main.cpp": "int renamed;\n" },
        { signal: AbortSignal.timeout(30) },
      ),
    );
    await access(path.join(root, ".renderer-edit-lock"));
    assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), before["main.cpp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
