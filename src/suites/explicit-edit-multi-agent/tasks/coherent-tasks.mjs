const preservation =
  "Preserve every current body, literal, macro and inactive branch, except the explicitly requested scaffolding changes or bound renames. Keep the neutral identity and all earlier results. Do not add comments. Independent definitions may use any dependency-safe order. Includes and namespace wrappers may differ if the project still builds. A simple unconditional standard using-declaration need not be repeated when an earlier project header supplies it in the required namespace and condition, or when all remaining uses are qualified. An unconditional std::string_literals namespace directive may move with its module if every literal consumer keeps its context. Harmless unconditional standard using-declarations may be added when they do not supply any new unqualified binding. A using-import must not extend an existing project overload family, even when current calls still select the same functions. Preserve other namespace using-directives, aliases and conditional using-declarations. Verification happens after this complete task, not after each table row.";

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
  return `${goal}\n\nAllowed changes: the module moves, scaffolding cleanup or owner-bound mappings in the target table below. Physical selectors identify current declarations, not a required final order. Each mapping applies only to its listed owners, never every occurrence of its spelling.${setup}\n\nTarget table (one JSON row per related target group):\n${targets.map((item) => JSON.stringify(item)).join("\n")}\n\n${preservation}`;
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
      `Restore the public interface module ${request.file}: extract its guarded header from main.cpp and replace that header body with the corresponding include. Preserve the current bound names.`,
      [request],
    );
  task(
    tasks,
    "structure",
    "image-resize",
    "Restore the image-resize support module as one merged header. Number the two embedded copies by their order in main.cpp: each has a guarded declaration section followed by a macro-controlled implementation section. Keep only the first copy's guarded declarations and the second copy's macro-controlled implementation in the listed header. Remove the redundant second declarations and first implementation; this removal is an explicit exception to preservation. Move the selected sections intact, retaining their current bound names, bodies, literals and inner conditional structure, including inactive alternatives. Do not keep the redundant copies behind new conditional wrappers. Replace the embedded declarations in main.cpp with the header include, and move implementation activation out of main.cpp into support/stb.cpp only.",
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
      `Restore the implementation module ${file}. Move all selected public definitions and their listed private dependency groups from main.cpp into this translation unit. Keep public declarations in their headers. Each selected body must have exactly one physical owner; do not leave facades or bypassed copies in main.cpp. Preserve the listed conditional include preambles and required using context. Remove the listed temporary forward declarations once their definitions have moved; keep the original public header declarations.`,
      operations,
    );
  task(
    tasks,
    "structure",
    "entry-point",
    "Finish the module boundaries: remove the listed temporary generated forward declarations from their current files, and empty namespaces and moved conditional include scaffolding from main.cpp. Keep original declarations. Retain its listed required includes (their order is free), entry point and remaining code. All extracted module bodies must stay in their requested files.",
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
    `Restore the ${category} naming interface of ${subsystem}. Apply the exact mappings in the owner table to declarations and all bound uses. Same-spelling bindings outside the selected owners must stay unchanged. Retain the module layout established by earlier tasks.`,
    operations,
  );
}
