/** Render one current goal with compact public targets. Shared module setup appears
 * once; optional reference-order anchors are not instructions for the live agent.
 * The structured scripted operations retain them as one dependency-safe route.
 */
export function coherentTaskPrompt(goal, operations) {
  const modules = new Map();
  const targets = operations.map(
    ({
      id: _id,
      phase: _phase,
      group: _group,
      target: _target,
      action,
      category: _category,
      ...operation
    }) => {
      if (action !== "implementation") return operation;
      const { includes, preamble, targets: selected, ...rest } = operation;
      const setup = { file: operation.file, includes, preamble };
      const previous = modules.get(operation.file);
      if (previous && JSON.stringify(previous) !== JSON.stringify(setup))
        throw Error("Conflicting module setup in coherent task");
      modules.set(operation.file, setup);
      return {
        ...rest,
        targets: selected.map(({ before: _before, after: _after, ...selection }) => selection),
      };
    },
  );
  const setup = modules.size
    ? `\n\nModule setup:\n${[...modules.values()].map((item) => JSON.stringify(item)).join("\n")}`
    : "";
  return `Perform only the following mechanical file edits. Leave all text outside the requested edits unchanged.\n\n${goal}${setup}\n\nTarget table (one JSON row per related target group):\n${targets.map((item) => JSON.stringify(item)).join("\n")}`;
}

function task(tasks, phase, subsystem, goal, operations) {
  if (!operations.length) throw Error("Empty coherent task");
  const publicOperations = operations.map(
    ({ prompt: _prompt, dependsOn: _dependsOn, ...operation }) => operation,
  );
  const item = {
    id: `task-${String(tasks.length + 1).padStart(3, "0")}`,
    phase,
    subsystem,
    goal,
    operations: publicOperations,
    prompt: coherentTaskPrompt(goal, publicOperations),
  };
  tasks.push(item);
  return item;
}

/** Prepare module goals from the old public inventory, without its pairwise swaps.
 * Operations remain public selectors for the model-free editor. Their old prose,
 * byte-driven lists and private source checkpoints are not new task instructions.
 */
export function coherentStructureTasks(requests) {
  const tasks = [];
  const structure = requests.filter((item) => item.phase === "structure");
  const declarations = structure.filter((item) => item.action === "remove-generated-declaration");
  for (const request of structure.filter((item) => item.action === "header"))
    task(
      tasks,
      "structure",
      request.file,
      `Extract the guarded header for ${request.file} from main.cpp into that file and replace its embedded body with the corresponding include.`,
      [request],
    );
  task(
    tasks,
    "structure",
    "image-resize",
    "Extract the image-resize module into the listed header. Number its two embedded copies by their order in main.cpp: each has guarded declarations followed by a macro-controlled implementation. Move the first copy's declarations and the second copy's implementation into the header; remove the redundant second declarations and first implementation. Replace the embedded declarations in main.cpp with the header include, and move implementation activation into support/stb.cpp.",
    structure
      .filter((item) => ["vendor-header", "vendor-implementation"].includes(item.action))
      .map((item) =>
        item.action === "vendor-header"
          ? { ...item, declarationsCopy: 1, implementationCopy: 2 }
          : { ...item, file: "support/stb.cpp" },
      ),
  );
  const modules = new Map();
  for (const request of structure.filter((item) => item.action === "implementation")) {
    if (!modules.has(request.file)) modules.set(request.file, []);
    modules.get(request.file).push(request);
  }
  for (const [file, operations] of modules)
    task(
      tasks,
      "structure",
      file,
      `Move the listed definitions and their selected private dependency groups from main.cpp into ${file}. Remove the listed temporary forward declarations after moving their definitions.`,
      operations,
    );
  task(
    tasks,
    "structure",
    "entry-point",
    "Remove the listed temporary generated forward declarations from their specified files, and the listed empty namespaces and moved conditional include scaffolding from main.cpp.",
    [...declarations, ...structure.filter((item) => item.action === "cleanup-empty-namespaces")],
  );
  const delivered = new Set(
    tasks.flatMap((item) => item.operations.map((operation) => operation.id)),
  );
  const required = structure.filter((item) => item.action !== "swap-definitions");
  if (delivered.size !== required.length || required.some((item) => !delivered.has(item.id)))
    throw Error("Missing or repeated structure contract target");
  return tasks;
}

/** Add one naming goal for a related subsystem/category run. File ownership is
 * resolved privately from compiler binding origins; only public current owners and
 * exact bound-name mappings are delivered. No inverse offsets leave preparation.
 */
export function appendCoherentNamingTask(tasks, category, subsystem, operations) {
  return task(
    tasks,
    "names",
    subsystem,
    `Apply the listed ${category} name mappings for ${subsystem} to the selected declarations and all their bound uses.`,
    operations,
  );
}
