import { isDeepStrictEqual } from "node:util";
import { GradeFailure } from "../../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import { applyRequest } from "../../../src/suites/explicit-edit-multi-agent/reference/scripted-worker.mjs";

const owners = { make_rect: "func_make_rect_routine", make_recty: "create_recty_func" };
const fail = (message) => {
  throw new GradeFailure("structure", message);
};
const key = (item) => JSON.stringify([item.kind, item.scope, item.name, item.type, item.ownerType]);
const geometry = (items, name) =>
  items.filter(
    (item) => item.kind === "FunctionDecl" && item.scope === "frond" && item.name === name,
  );
const isVoid = (item) => item.type?.startsWith("void (");

function renamed(text, mapping) {
  return text.replace(/[A-Za-z_][A-Za-z_0-9]*/g, (word) => mapping[word] ?? word);
}
function shape(node, mapping) {
  const [kind, operator, value, reference, children] = node;
  return [
    kind,
    operator,
    value,
    reference ? (mapping[reference] ?? reference) : reference,
    children.map((child) => shape(child, mapping)),
  ];
}

/** Derive trusted semantic expectations from the starting source and compiler,
 * not from candidate reports or reference checkpoints. The contract stays outside
 * every candidate mount. It supports only the accepted eleven-request slice.
 */
export function createSliceContract(initial, inspection) {
  const header = applyRequest(
    initial,
    "Move the complete common math header block guarded by `_FROND_MATH_H_` from `main.cpp` into `frond_math.h`.",
  )["frond_math.h"];
  const position = initial["main.cpp"].indexOf(header);
  if (position < 0)
    throw new GradeFailure("infrastructure", "Cannot locate the complete initial math block");
  const start = Buffer.byteLength(initial["main.cpp"].slice(0, position));
  const end = start + Buffer.byteLength(header);
  const math = inspection.declarations.filter(
    (item) =>
      item.file === "main.cpp" &&
      item.offset >= start &&
      item.offset < end &&
      item.kind !== "NamespaceDecl",
  );
  const functions = Object.fromEntries(
    Object.entries(owners).map(([owner, name]) => {
      const declarations = geometry(inspection.declarations, name);
      if (declarations.filter((item) => item.definition && isVoid(item)).length !== 1)
        throw new GradeFailure("infrastructure", `Missing initial geometry definition: ${owner}`);
      return [owner, declarations];
    }),
  );
  if (!math.length) throw new GradeFailure("infrastructure", "Initial math inventory is empty");
  const keys = new Set(math.map(key));
  const outside = {};
  for (const item of inspection.declarations) {
    if (keys.has(key(item)) && (item.offset < start || item.offset >= end))
      outside[key(item)] = (outside[key(item)] ?? 0) + 1;
  }
  const implementations = inspection.declarations.filter(
    (item) => item.kind === "FunctionDecl" && item.definition,
  );
  if (implementations.filter((item) => item.scope === "" && item.name === "main").length !== 1)
    throw new GradeFailure("infrastructure", "Missing compiled initial render entry point");
  return { pixels: inspection.pixels, math, outside, functions, implementations };
}

/** Check compiled ownership, bindings and active names without comparing source
 * files or formatting. Moved bodies retain their compiler expression shape and
 * bindings, allowing the requested name changes. This is a conservative pinned
 * refactoring check, not a proof of arbitrary equivalent rewrites or C++ behavior.
 */
export function assertCandidateObligations(inspection, active, contract) {
  if (!isDeepStrictEqual(inspection.pixels, contract.pixels))
    throw new GradeFailure("behavior", "Rendered scenes differ from the initial project");
  const items = inspection.declarations;
  const mapping = {};
  for (const [owner, old] of Object.entries(owners))
    mapping[old] =
      active[`${owner}-definition`]?.name ?? active[`${owner}-declaration`]?.name ?? old;
  if (active["vec4f-type"]) mapping.TVec4fType = active["vec4f-type"].name;
  if (active["vec4f-fields"]) mapping.fieldWMember = active["vec4f-fields"].name;
  if (active["math-module"]) {
    const normalize = (item) => ({
      ...item,
      name: renamed(item.name, mapping),
      scope: renamed(item.scope, mapping),
      type: item.type ? renamed(item.type, mapping) : item.type,
      ownerType: item.ownerType ? renamed(item.ownerType, mapping) : item.ownerType,
    });
    const expected = new Set(contract.math.map((item) => key(normalize(item))));
    const actual = new Set(
      items.filter((item) => item.file === active["math-module"].file).map(key),
    );
    for (const entry of expected)
      if (!actual.has(entry))
        fail("Common math declarations are not all owned by the requested header");
    const remaining = {};
    for (const item of items)
      if (expected.has(key(item)) && item.file !== active["math-module"].file)
        remaining[key(item)] = (remaining[key(item)] ?? 0) + 1;
    const allowed = new Map(
      Object.entries(contract.outside).map(([entry, count]) => {
        const [kind, scope, name, type, ownerType] = JSON.parse(entry);
        return [key(normalize({ kind, scope, name, type, ownerType })), count];
      }),
    );
    for (const [entry, count] of Object.entries(remaining))
      if (count > (allowed.get(entry) ?? 0))
        fail("Common math declarations remain outside their header");
  }
  for (const [owner, old] of Object.entries(owners)) {
    const name = mapping[old];
    const current = geometry(items, name);
    const original = contract.functions[owner];
    const localMapping = active[`${owner}-locals`]?.mapping ?? {};
    for (const category of ["declaration", "definition"]) {
      const obligation = active[`${owner}-${category}`];
      if (!obligation) continue;
      const selected = current.filter(
        (item) => isVoid(item) && item.definition === (category === "definition"),
      );
      if (selected.filter((item) => item.file === obligation.file).length !== 1)
        fail(`Missing or duplicate compiled owner: ${name}-${category}`);
      if (category === "definition" && selected.some((item) => item.file !== obligation.file))
        fail(`Compiled definition remains outside its owner: ${name}`);
    }
    for (const expected of original.filter((item) => item.definition)) {
      const candidates = current.filter(
        (item) => item.definition && isVoid(item) === isVoid(expected),
      );
      if (candidates.length !== 1) fail(`Missing or duplicate geometry implementation: ${name}`);
      const candidate = candidates[0];
      const variableMapping = isVoid(expected) ? localMapping : {};
      if (
        !isDeepStrictEqual(
          candidate.locals,
          expected.locals.map((word) => variableMapping[word] ?? word),
        )
      )
        fail(`Required owner-specific variable names differ: ${name}`);
      if (
        !isDeepStrictEqual(candidate.body, shape(expected.body, { ...mapping, ...variableMapping }))
      )
        fail(`Geometry body or bound uses changed outside the requested refactoring: ${name}`);
      if (!isVoid(expected) && candidate.file !== expected.file)
        fail(`Unrelated shape-returning overload moved: ${name}`);
    }
    if (Object.keys(localMapping).length) {
      for (const item of current.filter(isVoid)) {
        if (item.locals.some((word) => Object.hasOwn(localMapping, word)))
          fail(`Old owner-specific names remain: ${name}`);
      }
    }
    if (name !== old && geometry(items, old).length) fail(`Old function family remains: ${name}`);
  }
  if (active["vec4f-fields"]) {
    const owner = mapping.TVec4fType ?? "TVec4fType";
    const fields = items.filter(
      (item) => item.kind === "FieldDecl" && item.scope === `frond::${owner}`,
    );
    if (
      !fields.some((item) => item.name === active["vec4f-fields"].name) ||
      fields.some((item) => item.name === "fieldWMember")
    )
      fail("Required field name was not restored");
  }
  if (
    active["vec4f-type"] &&
    items.some((item) => item.scope === "frond" && item.name === "TVec4fType")
  )
    fail("Old vec4f type name remains");
  const mathKeys = new Set(contract.math.map(key));
  const implementationKeys = new Map();
  for (const item of items.filter((entry) => entry.kind === "FunctionDecl" && entry.definition)) {
    const entry = key(item);
    if (!implementationKeys.has(entry)) implementationKeys.set(entry, []);
    implementationKeys.get(entry).push(item);
  }
  for (const expected of contract.implementations) {
    if (expected.scope === "frond" && Object.values(owners).includes(expected.name)) continue;
    const normalized = {
      ...expected,
      name: renamed(expected.name, mapping),
      scope: renamed(expected.scope, mapping),
      type: expected.type ? renamed(expected.type, mapping) : expected.type,
      ownerType: expected.ownerType ? renamed(expected.ownerType, mapping) : expected.ownerType,
    };
    const file =
      active["math-module"] && mathKeys.has(key(expected))
        ? active["math-module"].file
        : expected.file;
    const current = (implementationKeys.get(key(normalized)) ?? []).filter(
      (item) => item.file === file,
    );
    if (current.length !== 1 || !isDeepStrictEqual(current[0].body, shape(expected.body, mapping)))
      fail("Render driver or unrelated implementation changed");
  }
}
