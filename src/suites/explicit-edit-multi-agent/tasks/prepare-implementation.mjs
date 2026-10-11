import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { referenceRoute } from "../generation/reference-route.mjs";
import { readTree, writeTree, treeIdentity } from "../generation/generator.mjs";
import { implementationInventory } from "./implementation-inventory.mjs";
import { implementationRequests } from "./implementation-groups.mjs";

/** Prepare binding-aware structural requests from a verified neutral generation.
 * Canonical named files are analysis inputs only, never mounted in the candidate executor.
 * Returns current declaration selectors and private inventories; no renderer check is claimed.
 */
export async function prepareImplementation(generation, output) {
  await mkdir(output);
  const manifest = JSON.parse(await readFile(path.join(generation, "operations.json"), "utf8"));
  const payload = await readTree(path.join(generation, "payload"));
  const route = referenceRoute(payload, manifest);
  const named = route.stages.findLast((stage) => stage.phase === "structure").tree;
  const analysis = path.join(output, "analysis");
  await writeTree(analysis, named);
  const all = [],
    external = [],
    includesByFile = {},
    preamblesByFile = {},
    inventory = {};
  for (const file of Object.keys(named).filter(
    (name) => name.endsWith(".cpp") && name !== "main.cpp" && !name.includes("/"),
  )) {
    console.log(`INVENTORY ${file}`);
    const current = await implementationInventory(path.join(analysis, file), named[file], file, [
      "-std=c++17",
      "-pthread",
      "-I",
      path.join(analysis, "support"),
    ]);
    all.push(...current.units);
    external.push(...current.external);
    includesByFile[file] = current.includes;
    preamblesByFile[file] = current.preamble;
    inventory[file] = current;
  }
  const requests = implementationRequests(all, { external, includesByFile, preamblesByFile });
  const report = {
    status: "planned",
    source: treeIdentity(payload),
    namedSource: treeIdentity(named),
    files: Object.keys(inventory).length,
    units: all.length,
    requests: requests.length,
  };
  await writeFile(path.join(output, "inventory.json"), JSON.stringify(inventory));
  await writeFile(path.join(output, "requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  return { requests, named, report, inventory };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareImplementation(path.resolve(process.argv[2]), path.resolve(process.argv[3])).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
