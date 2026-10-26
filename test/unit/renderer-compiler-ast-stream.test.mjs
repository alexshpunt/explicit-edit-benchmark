import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { projectAst } from "../../src/suites/explicit-edit-multi-agent/cpp/compiler-ast.mjs";

// Exercise the compiler transport with controlled JSON bytes, including root
// boundaries larger than a pipe chunk. No compiler semantics are mocked here:
// the contract is lossless filtering of the already emitted AST document.
async function stream(
  t,
  document,
  width,
  exitCode = 0,
  diagnostic = "controlled compiler failure",
  signal,
) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/compiler-ast-stream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "dump.json"),
    document.replaceAll(
      JSON.stringify("CURRENT"),
      JSON.stringify(path.join(directory, "current.cpp")),
    ),
  );
  const command = path.join(directory, "clang++");
  await writeFile(
    command,
    `#!${process.execPath}
import fs from 'node:fs';
import { once } from 'node:events';
(async () => {
 const bytes = fs.readFileSync(new URL('./dump.json', import.meta.url));
 for (let start = 0; start < bytes.length; start += ${width}) {
  if (!process.stdout.write(bytes.subarray(start, start + ${width}))) await once(process.stdout, 'drain');
 }
 if (${exitCode} || ${JSON.stringify(signal ?? null)}) process.stderr.write(${JSON.stringify(diagnostic)});
 if (${JSON.stringify(signal ?? null)}) process.kill(process.pid, ${JSON.stringify(signal ?? null)});
 process.exitCode = ${exitCode};
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
  );
  await chmod(command, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = `${directory}:${previous}`;
  try {
    return await projectAst(path.join(directory, "current.cpp"), ["-std=c++17"]);
  } finally {
    process.env.PATH = previous;
  }
}

for (const width of [1, 7, 65_536]) {
  await test(`streamed AST roots preserve escaped text and file inheritance with ${width}-byte writes`, async (t) => {
    const values = Array.from({ length: 1800 }, (_, index) => ({
      kind: "StringLiteral",
      value: `literal ${index}: \\" { inner: } \\ β`,
    }));
    const system = {
      id: "system",
      kind: "NamespaceDecl",
      name: "library",
      loc: { file: "/usr/include/library.h" },
      inner: values,
    };
    const own = {
      id: "own",
      kind: "NamespaceDecl",
      name: "project",
      loc: { file: "CURRENT" },
      inner: values,
    };
    const inherited = { id: "next", kind: "VarDecl", name: "after" };
    const included = {
      id: "included",
      kind: "NamespaceDecl",
      name: "included_namespace",
      loc: { file: "/usr/include/extra.h", includedFrom: { file: "CURRENT" } },
      inner: values,
    };
    // The fake compiler binds CURRENT to the actual source argument, just as
    // Clang writes absolute current-file locations in its JSON output.
    const document = JSON.stringify({
      kind: "TranslationUnitDecl",
      inner: [system, own, inherited, included],
    });
    const roots = await stream(t, document, width);
    assert.ok(roots[0].loc.file.endsWith("/current.cpp"));
    assert.deepEqual(
      roots.map((root) => (root.loc ? { ...root, loc: { ...root.loc, file: "CURRENT" } } : root)),
      [
        own,
        inherited,
        { id: "system", kind: "NamespaceDecl", name: "library" },
        { id: "included", kind: "NamespaceDecl", name: "included_namespace" },
      ],
    );
  });
}

await test("a real compiler source diagnostic is explicitly distinguished from process failure", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/compiler-source-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "current.cpp");
  await writeFile(source, "int value() { return missing; }\n");
  await assert.rejects(projectAst(source, ["-std=c++17"]), (error) => {
    assert.equal(error.compilerSourceFailure, true);
    assert.equal(error.compilerExitCode, 1);
    assert.equal(error.compilerSignal, null);
    assert.match(error.message, /use of undeclared identifier/);
    return true;
  });
});

await test("a real source error limit remains a source conflict, not a compiler crash", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/compiler-source-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "current.cpp");
  await writeFile(source, "int value() { return missing + another; }\n");
  await assert.rejects(projectAst(source, ["-std=c++17", "-ferror-limit=1"]), (error) => {
    assert.equal(error.compilerSourceFailure, true);
    assert.equal(error.compilerExitCode, 1);
    assert.equal(error.compilerSignal, null);
    assert.match(error.message, /too many errors emitted/);
    return true;
  });
});
for (const failure of [
  { code: 1, diagnostic: "clang++: error: unknown compiler argument" },
  { code: 2, diagnostic: "current.cpp:1:1: error: simulated process failure" },
  {
    code: 1,
    diagnostic:
      "current.cpp:1:1: error: invalid source\nclang++: error: unable to execute command: Killed",
  },
  { code: 1, diagnostic: "current.cpp:1:1: error: invalid source\nLLVM ERROR: backend crashed" },
  {
    code: 1,
    diagnostic: "current.cpp:1:1: error: interrupted source compilation",
    signal: "SIGTERM",
  },
])
  await test(`compiler process/driver failure remains fatal (${failure.signal ?? failure.code + ": " + failure.diagnostic})`, async (t) => {
    await assert.rejects(
      stream(t, '{"inner":[]}', 7, failure.code, failure.diagnostic, failure.signal),
      (error) => {
        assert.equal(error.compilerSourceFailure, false);
        assert.equal(error.compilerExitCode, failure.signal ? null : failure.code);
        assert.equal(error.compilerSignal, failure.signal ?? null);
        assert.match(error.message, /Compiler AST failed:/);
        return true;
      },
    );
  });
await test("an incomplete streamed AST and a failed compiler never return partial roots", async (t) => {
  await assert.rejects(
    stream(t, '{"inner":[{"kind":"NamespaceDecl","inner":[', 7),
    /Incomplete compiler AST/,
  );
  await assert.rejects(
    stream(t, '{"inner":[]}', 7, 1),
    /Compiler AST failed: controlled compiler failure/,
  );
});
