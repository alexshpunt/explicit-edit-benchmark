const inline = (value) => {
  const text = String(value);
  const fence = "`".repeat(
    Math.max(0, ...(text.match(/`+/g) ?? []).map((part) => part.length)) + 1,
  );
  return `${fence}${text}${fence}`;
};
const code = (value) => {
  const text = String(value);
  const fence = "`".repeat(
    Math.max(2, ...(text.match(/`+/g) ?? []).map((part) => part.length)) + 1,
  );
  return `${fence}cpp\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
};

function include(item) {
  if (typeof item === "string") return `#include "${item}"`;
  if (typeof item?.file !== "string" || typeof item.quoted !== "boolean")
    throw Error("Unsupported include in task instruction");
  return `#include ${item.quoted ? `"${item.file}"` : `<${item.file}>`}`;
}

/** Describe current source directly; no controller selector records leave this renderer. */
function selectedSource(selector) {
  if (
    !selector ||
    typeof selector.scope !== "string" ||
    Object.keys(selector).some(
      (key) =>
        ![
          "kind",
          "scope",
          "name",
          "signature",
          "definition",
          "owner",
          "declarator",
          "condition",
          "occurrence",
        ].includes(key),
    )
  )
    throw Error("Unsupported source selection in task instruction");
  const kind = selector.kind ?? "declaration";
  if (!["function", "variable", "type", "record", "conditional", "declaration"].includes(kind))
    throw Error("Unsupported source kind in task instruction");
  let text;
  if (selector.declarator !== undefined) {
    const form =
      selector.definition === true
        ? "definition"
        : selector.definition === false
          ? "declaration without a body"
          : "complete source unit";
    text = `the ${form} whose declaration header, ignoring whitespace, is ${inline(selector.declarator)} ${selector.scope === "::" ? "at global scope" : `in namespace ${inline(selector.scope)}`}`;
    if (selector.name !== undefined) text += `, named ${inline(selector.name)}`;
  } else if (kind === "conditional") {
    text = `the complete conditional block ${selector.scope === "::" ? "at global scope" : `in namespace ${inline(selector.scope)}`}`;
  } else {
    text = `the ${kind} ${inline(selector.scope)}`;
    if (selector.name !== undefined) text += ` named ${inline(selector.name)}`;
    if (selector.definition !== undefined)
      text += selector.definition ? " in its definition" : " in its declaration without a body";
  }
  if (selector.signature !== undefined) text += ` with type ${inline(selector.signature)}`;
  if (selector.condition !== undefined) text += ` opened by ${inline(selector.condition)}`;
  if (selector.occurrence !== undefined) {
    if (!Number.isSafeInteger(selector.occurrence) || selector.occurrence < 0)
      throw Error("Unsupported source occurrence in task instruction");
    text += `; select occurrence ${selector.occurrence + 1}, counting matching units from the start of the file`;
  }
  if (selector.owner) {
    const owner = selector.owner;
    if (
      Object.keys(owner).some((key) => !["scope", "signature", "definition"].includes(key)) ||
      typeof owner.scope !== "string"
    )
      throw Error("Unsupported enclosing owner in task instruction");
    text += `, inside function ${inline(owner.scope)}`;
    if (owner.signature !== undefined) text += ` with type ${inline(owner.signature)}`;
    if (owner.definition !== undefined)
      text += owner.definition ? " in its definition" : " in its declaration without a body";
  }
  return text;
}

function namingInstruction(operation) {
  if (!Array.isArray(operation.mapping) || !operation.mapping.length)
    throw Error("Missing name replacements in task instruction");
  const lines = operation.mapping.map(({ from, to }) => `Rename ${inline(from)} to ${inline(to)}.`);
  if (operation.selectors?.length) {
    lines.push(
      "Apply these renames only to the following bindings or the bindings owned by the following records/functions:",
    );
    for (const selector of operation.selectors) lines.push(`- ${selectedSource(selector)}.`);
  }
  if (operation.file) lines.push(`Limit this edit to ${inline(operation.file)}.`);
  else
    lines.push(
      "Update the selected declarations and all uses bound to them throughout the project.",
    );
  lines.push(
    "Preserve unrelated bindings with the same spelling, string literals, macros, and all names not requested above.",
  );
  return lines.join("\n");
}

function operationInstruction(operation, modules) {
  if (operation.phase === "names") return namingInstruction(operation);
  const file = inline(operation.file ?? "main.cpp");
  switch (operation.action) {
    case "header": {
      const lines = [
        `Move the complete header block guarded by ${inline(operation.guard)}, from its opening #ifndef through its matching #endif, out of main.cpp into ${file}. Preserve all declarations, definitions, directives and inactive branches inside it.`,
        `Replace that block in main.cpp with ${inline(`#include "${operation.file}"`)}.`,
      ];
      if (operation.includes?.length)
        lines.push(
          `Restore these direct project includes inside the new header in this order, including any lost during packing:\n${code(operation.includes.map(include).join("\n"))}`,
        );
      return lines.join("\n\n");
    }
    case "vendor-header": {
      return `Extract the image-resize header from main.cpp into ${file}. Number its embedded copies in source order. Retain the guarded declarations from copy ${operation.declarationsCopy}, guarded by ${inline(operation.guard)}, and the implementation from copy ${operation.implementationCopy}, controlled by ${inline(operation.macro)}. Preserve the complete retained blocks, including inactive branches. Remove the other declarations and implementation copies. Replace each embedded declaration block in main.cpp with ${inline(`#include "${operation.file}"`)}; remove the embedded implementation blocks. Keep the implementation activation in main.cpp for its separate move.`;
    }
    case "vendor-implementation": {
      return `Move ${inline(`#define ${operation.macro}`)} and its immediately paired image-resize include out of main.cpp into ${file}. Keep the declaration-only include in main.cpp. In ${file}, place exactly these two directives in this order:\n\n${code(`#define ${operation.macro}\n#include "stb_image/stb_image_resize.h"`)}`;
    }
    case "implementation": {
      const setup = {
        file: operation.file,
        includes: operation.includes,
        preamble: operation.preamble,
      };
      const previous = modules.get(operation.file);
      if (previous && JSON.stringify(previous) !== JSON.stringify(setup))
        throw Error("Conflicting module setup in coherent task");
      modules.set(operation.file, setup);
      const lines = [
        `Move the following complete source units from main.cpp into ${file}, in the order shown. Remove the moved units from main.cpp. Preserve their bodies, literals, conditional branches, namespace and using context; leave public header declarations and bound call sites unchanged.`,
      ];
      for (const [index, target] of operation.targets.entries()) {
        lines.push(`${index + 1}. Move ${selectedSource(target.selector)}.`);
        if (target.context?.length)
          lines.push(`Keep this using context with that unit:\n${code(target.context.join("\n"))}`);
        if (target.after)
          lines.push(
            `When already present in ${file}, place the moved unit after ${selectedSource(target.after)}.`,
          );
        if (target.before)
          lines.push(
            `When already present in ${file}, place the moved unit before ${selectedSource(target.before)}.`,
          );
      }
      if (!previous) {
        if (operation.includes?.length)
          lines.push(
            `Ensure ${file} has these direct includes in this order:\n${code(operation.includes.map(include).join("\n"))}`,
          );
        if (operation.preamble)
          lines.push(
            `When creating ${file}, retain this directive preamble:\n${code(operation.preamble)}`,
          );
      }
      lines.push(
        `Keep ${file} as a separate translation unit; do not include a .cpp file from another source file.`,
      );
      return lines.join("\n\n");
    }
    case "remove-generated-declaration": {
      return `Remove only ${selectedSource(operation.selector)} from ${file}. Keep its definition and all other declarations unchanged.`;
    }
    case "swap-definitions": {
      if (operation.selectors?.length !== 2) throw Error("A task swap requires two source units");
      return `In ${file}, exchange the positions of ${selectedSource(operation.selectors[0])} and ${selectedSource(operation.selectors[1])}. Move each complete definition without changing its contents; preserve all text between them.`;
    }
    case "cleanup-empty-namespaces": {
      const lines = [
        "Remove empty namespace blocks and their unused using directives from main.cpp after the implementation moves.",
      ];
      for (const preamble of operation.preambleSelectors ?? [])
        lines.push(
          `Remove the complete root-level conditional include block opened by ${inline(preamble.condition)} containing these includes, which have moved to their implementation files:\n${code(preamble.includes.map(include).join("\n"))}`,
        );
      if (operation.includes !== undefined)
        lines.push(
          operation.includes.length
            ? `Keep exactly these direct includes in main.cpp, in this order; remove other direct includes:\n${code(operation.includes.map(include).join("\n"))}`
            : "Remove all direct includes from main.cpp.",
        );
      lines.push(
        "Preserve every remaining declaration, definition, literal and nonempty namespace.",
      );
      return lines.join("\n\n");
    }
    default: {
      throw Error(`Unsupported original task action: ${operation.action}`);
    }
  }
}

/** Render exact requested edits in prose while retaining structured operations privately. */
export function coherentTaskPrompt(goal, operations) {
  const modules = new Map();
  const instructions = operations.map((operation) => operationInstruction(operation, modules));
  return [
    "Make only the following edits. Preserve earlier changes and unrelated source. Do not add comments or rename anything except the requested bindings.",
    goal,
    ...instructions,
  ].join("\n\n");
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
