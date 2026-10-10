import { execFile } from "node:child_process";
import { copyFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNeutralSource } from "../../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";

import { GradeFailure } from "../../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";

// Build artifacts are allowed, but are never inputs to the fresh compiler.
// Reject nonregular entries everywhere; validate text only for C++ source files.
async function sourceFiles(directory) {
  const sources = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (!entry.isFile()) throw new Error(`Unsupported source entry: ${name}`);
      else if ([".cpp", ".h"].some((extension) => name.endsWith(extension))) {
        const bytes = await readFile(path.join(directory, name));
        if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
          throw new Error(`Source is not valid UTF-8: ${name}`);
        assertNeutralSource(name, bytes.toString("utf8"));
        if (name.endsWith(".cpp")) sources.push(name);
      }
    }
  }
  await visit("");
  return sources.sort();
}

function mounts(workspace, scratch, inspector) {
  return [
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
    path.resolve(workspace),
    "/workspace",
    "--bind",
    path.resolve(scratch),
    "/build",
    "--ro-bind",
    path.resolve(inspector),
    "/inspector",
    "--chdir",
    "/workspace",
  ];
}

function command(args, category, { timeout = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/bwrap",
      args,
      { timeout, signal, env: {}, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const kind =
            error.killed ||
            error.signal ||
            error.code === "ABORT_ERR" ||
            typeof error.code !== "number"
              ? "infrastructure"
              : category;
          reject(new GradeFailure(kind, stderr.trim() || error.message, { cause: error }));
        } else resolve({ stdout, stderr });
      },
    );
  });
}

/** Freshly compile and inspect candidate source, then run two scenes twice in a
 * separate isolated process. Only the project, read-only runtime and disposable
 * evidence directory are mounted. Golden pixels and obligations stay in the host.
 * This inspector supports the root-level sources of the eleven-request slice.
 */
export async function inspectCandidate(workspace, evidence, { signal } = {}) {
  let sources;
  try {
    sources = await sourceFiles(workspace);
  } catch (error) {
    throw new GradeFailure("structure", error.message, { cause: error });
  }
  if (!sources.includes("main.cpp") || sources.some((file) => file.includes("/")))
    throw new GradeFailure("structure", "Expected main.cpp and root-level slice translation units");
  await mkdir(evidence);
  const inspector = path.join(evidence, "inspector");
  const build = path.join(evidence, "build");
  await mkdir(inspector);
  await mkdir(build);
  await copyFile(
    fileURLToPath(new URL("candidate-inspect.mjs", import.meta.url)),
    path.join(inspector, "candidate-inspect.mjs"),
  );
  const base = mounts(workspace, build, inspector);
  const environment = await command([...base, "/usr/bin/clang++", "--version"], "infrastructure", {
    signal,
    timeout: 10_000,
  });
  if (
    !/clang version 18\./.test(environment.stdout) ||
    process.platform !== "linux" ||
    process.arch !== "x64"
  )
    throw new GradeFailure("infrastructure", "Candidate grading requires Linux x64 and Clang 18");
  const compilation = await command(
    [
      ...base,
      "/usr/bin/clang++",
      "-std=c++17",
      "-O0",
      "-ffp-contract=off",
      "-pthread",
      ...sources.map((file) => `/workspace/${file}`),
      "-o",
      "/build/renderer",
    ],
    "build",
    { signal },
  );
  await writeFile(path.join(evidence, "compile.log"), compilation.stderr);
  const inspection = await command(
    [...base, process.execPath, "/inspector/candidate-inspect.mjs"],
    "build",
    { signal, timeout: 300_000 },
  );
  let declarations;
  try {
    declarations = JSON.parse(inspection.stdout);
  } catch (error) {
    throw new GradeFailure("infrastructure", "Invalid compiler inspection output", {
      cause: error,
    });
  }
  await writeFile(path.join(evidence, "declarations.json"), JSON.stringify(declarations) + "\n");
  const outputs = [];
  const renderBase = base.slice(0, base.indexOf("--bind"));
  renderBase.push("--ro-bind", path.resolve(build), "/build", "--chdir", "/workspace");
  for (const pass of ["scene", "repeat"]) {
    const renderDirectory = path.join(evidence, pass);
    await mkdir(renderDirectory);
    const render = await command(
      [
        ...renderBase,
        "--bind",
        path.resolve(renderDirectory),
        "/render",
        "/build/renderer",
        `/render/${pass}`,
      ],
      "behavior",
      { signal, timeout: 30_000 },
    );
    await writeFile(path.join(evidence, `${pass}.log`), render.stdout + render.stderr);
    const pixels = [];
    for (let scene = 0; scene < 2; scene++) {
      let bytes;
      try {
        const output = await open(
          path.join(renderDirectory, `${pass}-${scene}.rgba32f`),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await output.stat();
          if (!stat.isFile() || stat.size !== 32 * 32 * 4 * 4)
            throw new GradeFailure("behavior", "Unexpected float image dimensions or file type");
          bytes = await output.readFile();
        } finally {
          await output.close();
        }
      } catch (error) {
        throw new GradeFailure("behavior", "Renderer did not produce a regular float image", {
          cause: error,
        });
      }
      const rgb = [];
      for (let offset = 0; offset < bytes.length; offset += 4) {
        const value = bytes.readFloatLE(offset);
        if (!Number.isFinite(value)) throw new GradeFailure("behavior", "Non-finite pixel");
        if ((offset / 4) % 4 !== 3) rgb.push(value);
      }
      if (new Set(rgb).size < 2) throw new GradeFailure("behavior", "Constant replacement image");
      pixels.push(createHash("sha256").update(bytes).digest("hex"));
    }
    outputs.push(pixels);
  }
  if (JSON.stringify(outputs[0]) !== JSON.stringify(outputs[1]))
    throw new GradeFailure("behavior", "Repeated render differs");
  return { declarations, pixels: outputs[0] };
}
