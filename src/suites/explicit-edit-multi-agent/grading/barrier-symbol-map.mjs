import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeTree } from "../generation/generator.mjs";
import { GradeFailure } from "./failure.mjs";
import { compilerDiagnostics } from "./repair-diagnostics.mjs";
import { unitDeclarator } from "../cpp/cpp-structure.mjs";

const indexer = fileURLToPath(new URL("../cpp/barrier-symbol-index.py", import.meta.url));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Compiler bindings supplement the lexical protection of macros and inactive code.
 * Runs in a read-only isolated namespace, with no private contracts or host files.
 * Expected maps must be built from trusted preparation trees, never candidates.
 */
async function indexTree(tree, { evidence, signal } = {}) {
  assert.ok(evidence, "A fresh symbol-index evidence directory is required");
  signal?.throwIfAborted();
  await mkdir(path.dirname(path.resolve(evidence)), { recursive: true });
  await mkdir(evidence);
  const source = path.join(path.resolve(evidence), "source");
  await writeTree(source, tree);
  const args = [
    "--unshare-all",
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    source,
    "/workspace",
    "--ro-bind",
    indexer,
    "/indexer.py",
    "--chdir",
    "/workspace",
    "/usr/bin/python3",
    "/indexer.py",
  ];
  const child = spawn("/usr/bin/bwrap", args, { env: {}, signal });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(Object.keys(tree).sort()));
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, killed) =>
        killed ? reject(Error(`Symbol index terminated: ${killed}`)) : resolve(status),
      );
    });
  } finally {
    await writeFile(path.join(evidence, "index.log"), stderr);
  }
  signal?.throwIfAborted();
  if (code !== 0)
    throw new GradeFailure("infrastructure", `libclang barrier index failed (${code}): ${stderr}`);
  const result = JSON.parse(stdout);
  assert.equal(result.version, "renderer-barrier-symbol-map-v1");
  const buffers = new Map(
    Object.entries(tree).map(([file, source]) => [file, Buffer.from(source)]),
  );
  for (const record of result.symbols) {
    const { start, end, scope } = record.declaration;
    const source = buffers.get(record.file);
    const text = source.subarray(start, end).toString("utf8");
    try {
      record.declaration = {
        scope,
        selector: unitDeclarator(text, { start: 0, end: text.length }),
      };
    } catch {
      record.declaration = { scope };
    }
  }
  await writeFile(path.join(evidence, "symbols.json"), JSON.stringify(result) + "\n");
  return result;
}

export async function prepareBarrierSymbolMap(tree, options) {
  const map = await indexTree(tree, options);
  assert.equal(map.status, "pass", `Invalid trusted barrier source: ${map.diagnostics.join("\n")}`);
  return map;
}

/** Only relative file and declaration identity diagnostics leave the private map.
 * The controller projects these into public repair prompts; USRs, token hashes and
 * reference bindings stay in verifier evidence and are never model feedback.
 */
export async function evaluateBarrierSymbolMap(tree, expected, options) {
  assert.equal(expected.version, "renderer-barrier-symbol-map-v1");
  const actual = await indexTree(tree, options);
  const obligations = [];
  const add = (status, detail, id = digest(detail)) => obligations.push({ id, status, ...detail });
  const compiler = compilerDiagnostics(actual.diagnostics.join("\n"), tree);
  add(JSON.stringify(actual.files) === JSON.stringify(expected.files) ? "pass" : "fail", {
    kind: "files",
  });
  if (actual.status !== "pass") {
    const files = [...new Set(compiler.map((item) => item.file))];
    for (const file of files.length ? files : [undefined])
      add("fail", {
        kind: "compiler-symbols",
        reason: "source-unindexable",
        ...(file ? { file } : {}),
      });
  } else {
    const key = ({ count: _count, declaration: _declaration, ...record }) => JSON.stringify(record);
    const found = new Map(actual.symbols.map((record) => [key(record), record]));
    for (const record of expected.symbols) {
      const match = found.get(key(record));
      add(
        match?.count === record.count ? "pass" : "fail",
        {
          kind: "symbol",
          file: record.file,
          usr: record.usr,
          ...record.declaration,
          expected: record.count,
          actual: match?.count ?? 0,
        },
        digest(["symbol", key(record)]),
      );
      found.delete(key(record));
    }
    for (const record of found.values())
      add("fail", {
        kind: "unexpected-symbol",
        file: record.file,
        usr: record.usr,
        ...record.declaration,
        actual: record.count,
      });
  }
  const passed = obligations.filter((item) => item.status === "pass").length;
  return {
    status: passed === obligations.length ? "pass" : "fail",
    passed,
    total: obligations.length,
    obligations,
    compilerDiagnostics: compiler,
    // Only actual candidate facts may drive fresh diagnostics. Expected bindings
    // remain private verifier evidence and are never used as a repair payload.
    bindings: actual.bindings,
  };
}
