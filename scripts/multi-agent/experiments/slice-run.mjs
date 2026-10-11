import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { atomicSlice, assertSliceObligations } from "./atomic-slice.mjs";
import { buildAndRender } from "../../../src/suites/explicit-edit-multi-agent/generation/run.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

/** Generate a trusted small workload and verify every reference state without model calls.
 * Give an agent only workspace/ and the one selected request; trusted/ and review.md
 * contain future requests and reference answers and must stay outside its workspace.
 */
export async function sliceSeries(
  packed,
  manifestPath,
  output,
  { verify = true, log = console.log } = {},
) {
  output = path.resolve(output);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(path.join(output, "trusted"));
  const report = { version: "renderer-atomic-slice-v2", status: "unverified", checks: [] };
  const save = () =>
    writeFile(path.join(output, "trusted/report.json"), JSON.stringify(report, null, 2) + "\n");
  await save();
  try {
    if (verify) {
      const version = execFileSync("clang++", ["--version"], { encoding: "utf8" })
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
      };
    }
    const payload = await readTree(packed);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const route = await atomicSlice(payload, manifest, path.join(output, "trusted/analysis"));
    await writeTree(path.join(output, "workspace"), payload);
    await writeFile(
      path.join(output, "trusted/workload.json"),
      JSON.stringify(
        {
          version: route.version,
          initial: route.initial,
          steps: route.steps,
          obligations: route.obligations,
        },
        null,
        2,
      ) + "\n",
    );
    const review = [
      "# Atomic renderer slice",
      "",
      "Experimental partial route, not the full benchmark. Start with workspace/main.cpp. All support extraction is a request, not hidden preparation. Structure comes before names. The rest of the project stays mixed and renamed.",
      "",
      "Do not give this review or trusted/ to an agent. Deliver only its current request.",
      "",
    ];
    for (const step of route.steps)
      review.push(`## ${step.id} — ${step.phase}`, "", step.prompt, "");
    await writeFile(path.join(output, "review.md"), review.join("\n"));
    let golden;
    for (const [index, stage] of route.stages.entries()) {
      const id = index ? route.steps[index - 1].id : "initial";
      const directory = path.join(output, "trusted/states", id);
      await mkdir(directory, { recursive: true });
      await writeTree(path.join(directory, "source"), stage.tree);
      const check = {
        id,
        phase: stage.phase,
        identity: treeIdentity(stage.tree),
        status: "unverified",
      };
      report.checks.push(check);
      if (index) {
        assertSliceObligations(stage.tree, route.obligations[index - 1]);
        check.obligations = "pass";
      }
      await save();
      if (verify) {
        log(`BUILD ${id}: ${stage.phase}`);
        const pixels = await buildAndRender(
          path.join(directory, "source"),
          path.join(directory, "build"),
          stage.tree,
          "clang++",
        );
        golden ??= pixels;
        if (JSON.stringify(pixels) !== JSON.stringify(golden))
          throw new Error(`Rendered pixels differ at ${id}`);
        Object.assign(check, { status: "pass", pixels });
        log(`PASS ${id}: fresh build, two exact scenes, repeat render`);
        await save();
      }
    }
    report.status = verify ? "pass" : "unverified";
    report.initial = route.initial;
    report.steps = route.steps.length;
    await save();
    log(
      `${verify ? "VERIFIED" : "UNVERIFIED"} SLICE: ${route.steps.length} requests, ${route.stages.length} states; full mixed input, structure before names`,
    );
    return report;
  } catch (error) {
    report.status = "fail";
    const last = report.checks.at(-1);
    if (last?.status === "unverified") last.status = "fail";
    await save();
    throw error;
  }
}

/** Read one current request only; future requests and reference state are not included. */
export async function currentRequest(output, id) {
  const workload = JSON.parse(await readFile(path.join(output, "trusted/workload.json"), "utf8"));
  const step = workload.steps.find((item) => item.id === id);
  if (!step) throw new Error("Unknown request ID");
  return `# ${step.id}\n\n${step.prompt}\n`;
}

async function main(args) {
  if (args.length === 4 && args[0] === "generate") await sliceSeries(...args.slice(1));
  else if (args.length === 3 && args[0] === "request")
    console.log(await currentRequest(args[1], args[2]));
  else
    throw new Error(
      "Usage: node scripts/multi-agent/experiments/slice-run.mjs generate PACKED_SOURCE OPERATIONS_JSON OUTPUT\n   or: node scripts/multi-agent/experiments/slice-run.mjs request OUTPUT STEP_ID",
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
