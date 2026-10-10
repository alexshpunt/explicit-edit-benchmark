import { referenceLayoutSteps, referenceRoute } from "../generation/reference-route.mjs";
import { headerRestoration } from "./restoration-extraction.mjs";
import { restorationNameRequests } from "./restoration-requests.mjs";
import { cppStructure } from "../cpp/cpp-structure.mjs";
import { includeDirectives } from "../cpp/cpp-tokens.mjs";
import {
  physicalSelector,
  applyFullStructure,
  includePreambleSelector,
} from "../reference/full-structure-edit.mjs";
import { compactBlankLines, treeIdentity } from "../generation/generator.mjs";

const physicalUnits = (source) =>
  cppStructure(source, { expandNamespaceConditionals: true }).units.filter(
    (unit) => unit.kind !== "using",
  );
const compact = (tree) => compactBlankLines(tree).tree;

/** Prepare public atomic layout requests from verified private transitions.
 * Only current declarators and placement instructions leave preparation, never bodies or offsets.
 */
export function layoutRequests(payload, manifest) {
  let current = payload;
  const requests = [];
  for (const step of referenceLayoutSteps(payload, manifest)) {
    const source = current["main.cpp"],
      next = step.tree["main.cpp"];
    const before = physicalUnits(source),
      after = physicalUnits(next);
    const text = (unit) => source.slice(unit.start, unit.end);
    const nextText = (unit) => next.slice(unit.start, unit.end);
    let request;
    if (step.action === "swap-definitions") {
      if (before.length !== after.length) throw new Error("Layout swap changed unit count");
      const changed = before.filter((unit, index) => text(unit) !== nextText(after[index]));
      if (changed.length !== 2) throw new Error("Layout swap is not two whole units");
      request = {
        action: step.action,
        selectors: changed.map((unit) => physicalSelector(source, unit, true)),
      };
    } else {
      if (before.length !== after.length + 1)
        throw new Error("Prototype removal changed other units");
      let index = 0;
      while (index < after.length && text(before[index]) === nextText(after[index])) index++;
      for (let rest = index; rest < after.length; rest++)
        if (text(before[rest + 1]) !== nextText(after[rest]))
          throw new Error("Prototype removal changed another unit");
      request = { action: step.action, selector: physicalSelector(source, before[index], false) };
    }
    request.id = step.target;
    request.phase = "structure";
    request.group = step.action;
    request.prompt = `${step.action === "swap-definitions" ? "Swap these two complete definitions in main.cpp" : "Remove this generated declaration from main.cpp"}. Preserve all other code, names and literals. Current physical selectors: ${JSON.stringify(request.selectors ?? request.selector)}. Do not add comments. Keep earlier changes. Verification is after the batch.`;
    const actual = applyFullStructure(current, request);
    if (treeIdentity(actual) !== treeIdentity(compact(step.tree)))
      throw new Error(`Independent layout request differs: ${step.target}`);
    requests.push(request);
    current = actual;
  }
  return { requests, final: current };
}

/** Assemble the full structure-first neutral workload. Private canonical sources stay with the grader. */
export function fullRestoration(payload, manifest, implementation, namingOptions) {
  const layout = layoutRequests(payload, manifest);
  const headers = headerRestoration(payload, manifest);
  if (treeIdentity(layout.final) !== treeIdentity(headers.initial))
    throw new Error("Header start differs from layout endpoint");
  const vendor = [
    {
      id: "vendor-header",
      action: "vendor-header",
      file: "support/stb_image/stb_image_resize.h",
      guard: "STBIR_INCLUDE_STB_IMAGE_RESIZE_H",
      macro: "STB_IMAGE_RESIZE_IMPLEMENTATION",
      prompt:
        "Extract the macro-controlled image resize header into support/stb_image/stb_image_resize.h. Merge the active declarations from the first guarded copy and active implementation from the last copy, preserving current bound names, directives and inactive branches. Replace both copies with includes. Do not add comments or rename bindings.",
    },
    {
      id: "vendor-implementation",
      action: "vendor-implementation",
      macro: "STB_IMAGE_RESIZE_IMPLEMENTATION",
      prompt:
        "Move the image resize implementation activation and paired include from main.cpp into support/stb.cpp. Preserve the declaration include in main.cpp. Use the relative include stb_image/stb_image_resize.h in the new implementation file. Do not change any names or bodies.",
    },
  ].map((request) => ({ ...request, phase: "structure", group: "vendor" }));
  const reference = referenceRoute(payload, manifest);
  const canonicalNamed = reference.stages.findLast((stage) => stage.phase === "structure").tree;
  const mainIncludes = includeDirectives(canonicalNamed["main.cpp"]).map(({ file, quoted }) => ({
    file,
    quoted,
  }));
  const preambleSelectors = new Map();
  for (const request of implementation) {
    const preamble = request.preamble ?? "";
    for (const unit of cppStructure(preamble).units) {
      if (unit.kind !== "conditional") continue;
      const selector = includePreambleSelector(preamble, unit);
      preambleSelectors.set(JSON.stringify(selector), selector);
    }
  }
  const requests = [
    ...layout.requests,
    ...headers.requests.map((request) => ({ ...request, action: "header" })),
    ...vendor,
    ...implementation.map((request, index) => ({
      ...request,
      id: `implementation-${index + 1}`,
      action: "implementation",
      phase: "structure",
      group: request.file,
    })),
    {
      id: "cleanup-namespaces",
      phase: "structure",
      group: "cleanup",
      action: "cleanup-empty-namespaces",
      includes: mainIncludes,
      preambleSelectors: [...preambleSelectors.values()],
      prompt: `Clean up main.cpp after implementation extraction: remove empty namespace blocks and their unused using directives. Remove the listed conditional include preambles that have moved to their implementation files. Keep exactly the listed direct includes in order; remove other direct includes from main.cpp. Preserve all remaining declarations, definitions and literals. Do not add comments or change names.\nMoved preamble selectors: ${JSON.stringify([...preambleSelectors.values()])}\nDirect includes: ${JSON.stringify(mainIncludes)}`,
    },
    ...restorationNameRequests(manifest, namingOptions).map((request) => ({
      ...request,
      id: request.target,
      group: `${request.category}:${request.file ?? "project"}`,
    })),
  ];
  for (const [index, request] of requests.entries())
    request.dependsOn = index ? [requests[index - 1].id] : [];
  return {
    version: "renderer-full-restoration-v1",
    requests,
    canonicalNamed,
    canonicalFinal: reference.stages.at(-1).tree,
  };
}
