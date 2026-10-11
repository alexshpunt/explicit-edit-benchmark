import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  pack,
  compactBlankLines,
  packingPlan,
  prepareTree,
  readTree,
  treeIdentity,
  writeTree,
} from "./generator.mjs";
import { renameCategory } from "./semantic-names.mjs";
import { mixFunctions } from "./function-mix.mjs";
import { maskOrigin } from "./origin-markers.mjs";
import { reverseOperation } from "./inverse.mjs";
import { referenceRoute } from "./reference-route.mjs";
export { reverseOperation } from "./inverse.mjs";

const execFile = promisify(execFileCallback);
const fixture = fileURLToPath(
  new URL("../../../../fixtures/explicit-edit-multi-agent/", import.meta.url),
);
const flags = ["-std=c++17", "-O0", "-ffp-contract=off", "-pthread"];
const commandOptions = {
  timeout: 120_000,
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, LC_ALL: "C" },
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Freshly compile a source tree and render both pinned scenes twice, returning exact pixel hashes. */
export async function buildAndRender(source, scratch, tree, compiler, { signal } = {}) {
  const options = { ...commandOptions, signal };
  await mkdir(scratch);
  const executable = path.join(scratch, "renderer");
  const sources = Object.keys(tree)
    .filter((name) => name.endsWith(".cpp"))
    .sort();
  await execFile(
    compiler,
    [
      ...flags,
      ...(Object.keys(tree).some((name) => name.startsWith("support/"))
        ? ["-I", path.join(source, "support")]
        : []),
      ...sources.map((name) => path.join(source, name)),
      "-o",
      executable,
    ],
    options,
  );
  const outputs = [];
  for (const pass of ["scene", "repeat"]) {
    await execFile(executable, [path.join(scratch, pass)], options);
    const pixels = [];
    for (const variant of [0, 1]) {
      const bytes = await readFile(path.join(scratch, `${pass}-${variant}.rgba32f`));
      if (bytes.length !== 32 * 32 * 4 * 4) throw new Error("Wrong rendered image size");
      const values = [];
      for (let offset = 0; offset < bytes.length; offset += 4) {
        if (offset % 16 !== 12) values.push(bytes.readFloatLE(offset));
      }
      if (!values.every(Number.isFinite) || new Set(values).size < 2)
        throw new Error("Invalid or constant rendered image");
      pixels.push(hash(bytes));
    }
    outputs.push(pixels);
  }
  if (JSON.stringify(outputs[0]) !== JSON.stringify(outputs[1]))
    throw new Error("Repeated render differs");
  return outputs[0];
}

/** Generate packing and optional naming/mixing records, then verify every forward and inverse state. */
export async function generateSeries(
  output,
  { verify = true, compiler = "clang++", names = false, log = console.log } = {},
) {
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const original = await readTree(fixture);
  const initial = prepareTree(original);
  await writeTree(
    path.join(output, "notices"),
    Object.fromEntries(Object.entries(original).filter(([name]) => !/\.(cpp|h)$/.test(name))),
  );
  const operations = [];
  const checks = [];
  const report = {
    initial: treeIdentity(initial),
    final: null,
    operations,
    checks,
    environment: null,
    preparation: {
      original: treeIdentity(original),
      canonical: treeIdentity(initial),
      status: "unverified",
    },
    payload: { files: ["main.cpp"], status: "unverified" },
  };
  if (verify) {
    const version = (await execFile(compiler, ["--version"], commandOptions)).stdout
      .split("\n")
      .slice(0, 2);
    if (
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !/clang version 18\./.test(version[0])
    ) {
      throw new Error("Verification currently requires Linux x64 and Clang 18");
    }
    report.environment = {
      platform: process.platform,
      architecture: process.arch,
      compiler: version,
      flags,
    };
  }
  const saveReport = () =>
    writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  let golden;
  async function checkpoint(direction, index, tree) {
    const label = `${direction}/${String(index).padStart(2, "0")}`;
    const directory = path.join(output, label);
    await mkdir(directory, { recursive: true });
    await writeTree(path.join(directory, "source"), tree);
    const check = { state: label, identity: treeIdentity(tree), status: "unverified" };
    checks.push(check);
    if (verify) {
      log(`BUILD ${label}`);
      try {
        const pixels = await buildAndRender(
          path.join(directory, "source"),
          path.join(directory, "build"),
          tree,
          compiler,
        );
        golden ??= pixels;
        if (JSON.stringify(pixels) !== JSON.stringify(golden))
          throw new Error("Rendered pixels differ from the clean fixture");
        Object.assign(check, { status: "pass", pixels });
      } catch (error) {
        check.status = "fail";
        await saveReport();
        throw new Error(`Checkpoint ${label} failed: ${error.message}`, { cause: error });
      }
      log(`PASS  ${label}: fresh build, exact pixels, repeat render`);
    }
    await saveReport();
  }
  if (verify) {
    const directory = path.join(output, "original");
    await mkdir(directory);
    await writeTree(path.join(directory, "source"), original);
    log("BUILD original: comment-removal reference");
    golden = await buildAndRender(
      path.join(directory, "source"),
      path.join(directory, "build"),
      original,
      compiler,
    );
  }
  await checkpoint("forward", 0, initial);
  if (verify) report.preparation.status = "pass";
  let current = initial;
  const plan = packingPlan(initial);
  for (const [index, operation] of plan.entries()) {
    const result = pack(current, operation);
    current = result.tree;
    operations.push(result.record);
    await checkpoint("forward", index + 1, current);
  }
  if (names) {
    await mkdir(path.join(output, "naming"));
    for (const category of ["functions-types", "fields", "locals-parameters"]) {
      log(`RENAME ${category}`);
      const result = await renameCategory(current, category, path.join(output, "naming", category));
      current = result.tree;
      operations.push(result.record);
      log(
        `RENAMED ${category}: ${result.record.selection.length} declarations, ${result.record.edits.length} token edits`,
      );
      await checkpoint("forward", operations.length, current);
      log(
        `VARIETY ${category}: ${JSON.stringify(result.record.variety.forms)}; ${result.record.variety.substitutedFamilies} families with word substitutions`,
      );
      for (const example of result.record.variety.examples)
        log(`NAME ${example.role}/${example.form}: ${example.name} -> ${example.newName}`);
    }
  }
  if (names) {
    log("MIX: compiler-bound declarations and whole definitions");
    const result = await mixFunctions(current, path.join(output, "mixing"), {
      history: operations,
    });
    report.mixing = {
      ...result.summary,
      inputState: `forward/${operations.length}`,
      state: `forward/${operations.length + result.stages.length}`,
    };
    for (const stage of result.stages) {
      current = stage.tree;
      operations.push(stage.record);
      await checkpoint("forward", operations.length, current);
    }
    log(
      `MIXED: ${result.summary.moved}/${result.summary.selected} selected functions moved; ${result.summary.crossRegionMoves} cross-source-region moves`,
    );
    for (const pair of result.summary.related.slice(0, 5))
      log(`DISTANCE ${pair.caller} -> ${pair.callee}: ${pair.before} -> ${pair.after} lines`);
  }
  if (names) {
    const masked = maskOrigin(current);
    current = masked.tree;
    if (/yocto/i.test(current["main.cpp"]))
      throw new Error("Unmasked Yocto marker in payload code");
    operations.push(masked.record);
    report.origin = {
      vocabulary: masked.record.vocabulary,
      seed: masked.record.seed,
      name: masked.record.name,
      tokens: masked.record.edits.length,
      state: `forward/${operations.length}`,
    };
    log(
      `ORIGIN: ${masked.record.edits.length} tokens masked consistently as ${masked.record.name}`,
    );
    await checkpoint("forward", operations.length, current);
  }
  const compacted = compactBlankLines(current);
  current = compacted.tree;
  operations.push(compacted.record);
  log(
    `TRIM: ${compacted.record.edits.length} blank-line runs trimmed; at most one internal blank line, no blank edge lines`,
  );
  await checkpoint("forward", operations.length, current);
  report.final = treeIdentity(current);
  if (JSON.stringify(Object.keys(current)) !== JSON.stringify(["main.cpp"]))
    throw new Error("Final project is not a self-contained monolith");
  await writeTree(path.join(output, "payload"), current);
  if (verify) {
    log("BUILD payload: monolith only, no project includes or libraries");
    const pixels = await buildAndRender(
      path.join(output, "payload"),
      path.join(output, "payload-build"),
      current,
      compiler,
    );
    if (JSON.stringify(pixels) !== JSON.stringify(golden)) throw new Error("Payload pixels differ");
    Object.assign(report.payload, { status: "pass", pixels });
  }
  await writeFile(
    path.join(output, "operations.json"),
    `${JSON.stringify({ initial: report.initial, final: report.final, operations }, null, 2)}\n`,
  );
  await checkpoint("reverse", operations.length, current);
  for (let index = operations.length - 1; index >= 0; index--) {
    current = reverseOperation(current, operations[index]);
    await checkpoint("reverse", index, current);
  }
  if (treeIdentity(current) !== report.initial)
    throw new Error("Complete inverse did not restore the fixture");
  await saveReport();
  log(
    `${verify ? "VERIFIED" : "UNVERIFIED"}: ${operations.length} operations, ${checks.length} checkpoints; inverse restores exact source tree`,
  );
  return report;
}

/** Save and optionally verify structure-first restoration, using only a payload and its records. */
export async function restoreSeries(
  packed,
  manifestPath,
  output,
  { verify = true, compiler = "clang++", log = console.log } = {},
) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const route = referenceRoute(await readTree(packed), manifest);
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const report = {
    initial: route.initial,
    final: route.final,
    status: "unverified",
    environment: null,
    checks: [],
  };
  if (verify) {
    const version = (await execFile(compiler, ["--version"], commandOptions)).stdout
      .split("\n")
      .slice(0, 2);
    if (
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !/clang version 18\./.test(version[0])
    )
      throw new Error("Verification currently requires Linux x64 and Clang 18");
    report.environment = {
      platform: process.platform,
      architecture: process.arch,
      compiler: version,
      flags,
    };
  }
  const saveReport = () =>
    writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  let golden;
  for (const [index, stage] of route.stages.entries()) {
    const label = `${stage.phase}/${String(index).padStart(2, "0")}`;
    const directory = path.join(output, label);
    await mkdir(directory, { recursive: true });
    await writeTree(path.join(directory, "source"), stage.tree);
    const check = {
      state: label,
      action: stage.action,
      identity: treeIdentity(stage.tree),
      status: "unverified",
    };
    report.checks.push(check);
    await saveReport();
    if (verify) {
      log(`BUILD ${label}: ${stage.action}`);
      try {
        const pixels = await buildAndRender(
          path.join(directory, "source"),
          path.join(directory, "build"),
          stage.tree,
          compiler,
        );
        golden ??= pixels;
        if (JSON.stringify(pixels) !== JSON.stringify(golden))
          throw new Error("Reference pixels differ from the monolith");
        Object.assign(check, { status: "pass", pixels });
      } catch (error) {
        check.status = "fail";
        report.status = "fail";
        await saveReport();
        throw new Error(`Reference checkpoint ${label} failed: ${error.message}`, { cause: error });
      }
      log(`PASS  ${label}: fresh build, exact pixels, repeat render`);
      await saveReport();
    }
  }
  await writeTree(path.join(output, "restored"), route.stages.at(-1).tree);
  report.status = verify ? "pass" : "unverified";
  await saveReport();
  log(
    `${verify ? "VERIFIED" : "UNVERIFIED"} REFERENCE: ${route.stages.length - 1} transitions, ${route.stages.length} checkpoints; structure first, names last`,
  );
  return report;
}
async function main(args) {
  if (args.length === 2 && ["generate", "generate-names"].includes(args[0])) {
    await generateSeries(args[1], { names: args[0] === "generate-names" });
  } else if (args.length === 4 && args[0] === "restore") {
    await restoreSeries(args[1], args[2], args[3]);
  } else if (args.length === 4 && args[0] === "unpack") {
    const [, packed, manifestPath, output] = args;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    let current = await readTree(packed);
    if (treeIdentity(current) !== manifest.final)
      throw new Error("Final packed tree identity does not match");
    for (const record of [...manifest.operations].reverse())
      current = reverseOperation(current, record);
    if (treeIdentity(current) !== manifest.initial)
      throw new Error("Complete inverse identity does not match");
    await writeTree(path.resolve(output), current);
    console.log(
      `UNPACKED: ${manifest.operations.length} inverse operations; exact canonical tree (build not rerun)`,
    );
  } else {
    throw new Error(
      "Usage: node src/suites/explicit-edit-multi-agent/generation/run.mjs generate|generate-names OUTPUT\n   or: node src/suites/explicit-edit-multi-agent/generation/run.mjs unpack|restore PACKED_SOURCE OPERATIONS_JSON OUTPUT",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
