import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { GradeFailure } from "./failure.mjs";

const exec = promisify(execFile);

/** Build a read-only candidate snapshot and render both scenes twice in separate
 * namespaces. Trusted contracts, pixels, host files and credentials are not mounts.
 * Output logs are private evidence; no compiler or render diagnostics reach the agent.
 */
export async function buildCoherentCandidate(source, evidence, tree, { signal } = {}) {
  await mkdir(evidence);
  const build = path.join(evidence, "build");
  await mkdir(build);
  function base() {
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
      path.resolve(source),
      "/workspace",
      "--chdir",
      "/workspace",
    ];
  }
  async function command(args, category, log, timeout) {
    signal?.throwIfAborted();
    try {
      const result = await exec("/usr/bin/bwrap", args, {
        env: {},
        signal,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
      });
      await writeFile(path.join(evidence, log), result.stdout + result.stderr);
      signal?.throwIfAborted();
      return result.stdout;
    } catch (error) {
      await writeFile(
        path.join(evidence, log),
        `${error.stdout ?? ""}${error.stderr ?? ""}\n${error.message}`,
      );
      signal?.throwIfAborted();
      throw new GradeFailure(
        error.killed || error.signal || typeof error.code !== "number"
          ? "infrastructure"
          : category,
        error.message,
        { cause: error },
      );
    }
  }
  const version = await command(
    [...base(), "/usr/bin/clang++", "--version"],
    "infrastructure",
    "compiler.log",
    10000,
  );
  if (!/clang version 18\./.test(version) || process.platform !== "linux" || process.arch !== "x64")
    throw new GradeFailure("infrastructure", "Coherent grading requires Linux x64 and Clang 18");
  await command(
    [
      ...base(),
      "--bind",
      build,
      "/build",
      "/usr/bin/clang++",
      "-std=c++17",
      "-O0",
      "-ffp-contract=off",
      "-pthread",
      "-I",
      "/workspace/support",
      ...Object.keys(tree)
        .filter((file) => file.endsWith(".cpp"))
        .sort()
        .map((file) => `/workspace/${file}`),
      "-o",
      "/build/renderer",
    ],
    "build",
    "compile.log",
    300000,
  );
  const passes = [];
  for (const pass of ["scene", "repeat"]) {
    const render = path.join(evidence, pass);
    await mkdir(render);
    await command(
      [
        ...base(),
        "--ro-bind",
        build,
        "/build",
        "--bind",
        render,
        "/render",
        "/build/renderer",
        `/render/${pass}`,
      ],
      "behavior",
      `${pass}.log`,
      30000,
    );
    const pixels = [];
    for (const scene of [0, 1]) {
      let output;
      try {
        output = await open(
          path.join(render, `${pass}-${scene}.rgba32f`),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        throw new GradeFailure("behavior", "Missing or unsafe rendered image", { cause: error });
      }
      try {
        const stat = await output.stat();
        if (!stat.isFile() || stat.size !== 32 * 32 * 4 * 4)
          throw new GradeFailure("behavior", "Wrong float image shape or type");
        const bytes = await output.readFile();
        const values = [];
        for (let offset = 0; offset < bytes.length; offset += 4) {
          const value = bytes.readFloatLE(offset);
          if (!Number.isFinite(value))
            throw new GradeFailure("behavior", "Non-finite rendered pixel");
          if (offset % 16 !== 12) values.push(value);
        }
        if (new Set(values).size < 2)
          throw new GradeFailure("behavior", "Constant replacement image");
        pixels.push(createHash("sha256").update(bytes).digest("hex"));
      } finally {
        await output.close();
      }
    }
    passes.push(pixels);
  }
  if (JSON.stringify(passes[0]) !== JSON.stringify(passes[1]))
    throw new GradeFailure("behavior", "Repeated render differs");
  signal?.throwIfAborted();
  return passes[0];
}
