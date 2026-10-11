import { createHash } from "node:crypto";

/** Fixed, reviewed naming vocabulary. Alternatives preserve meaning rather than promise new behavior. */
export const vocabulary = {
  version: "renderer-names-v1",
  words: {
    make: ["create", "build"],
    create: ["make", "build"],
    build: ["make", "construct"],
    compute: ["calculate", "calc"],
    calculate: ["compute", "calc"],
    eval: ["evaluate"],
    evaluate: ["eval"],
    convert: ["transform", "conv"],
    copy: ["duplicate", "dup"],
    duplicate: ["copy", "dup"],
    initialize: ["init"],
    init: ["initialize"],
    update: ["revise", "upd"],
    allocate: ["alloc"],
    alloc: ["allocate"],
    deallocate: ["dealloc"],
    destroy: ["dispose"],
    append: ["add"],
    insert: ["ins"],
    remove: ["erase", "rm"],
    erase: ["remove"],
    find: ["locate"],
    search: ["seek"],
    lookup: ["look_up"],
    fetch: ["retrieve"],
    load: ["read"],
    save: ["write"],
    write: ["output"],
    read: ["input"],
    decode: ["unpack"],
    encode: ["pack"],
    format: ["fmt"],
    parse: ["prs"],
    validate: ["check"],
    check: ["verify"],
    compare: ["cmp"],
    equals: ["equal"],
    image: ["img", "raster"],
    images: ["imgs", "rasters"],
    pixel: ["px"],
    pixels: ["pxs"],
    texture: ["tex"],
    textures: ["texs"],
    color: ["colour", "clr"],
    colors: ["colours", "clrs"],
    scene: ["scn"],
    scenes: ["scns"],
    camera: ["cam"],
    cameras: ["cams"],
    material: ["matl"],
    materials: ["matls"],
    shape: ["shp"],
    shapes: ["shps"],
    mesh: ["msh"],
    meshes: ["mshs"],
    geometry: ["geom"],
    instance: ["inst"],
    instances: ["insts"],
    environment: ["env"],
    environments: ["envs"],
    light: ["lamp", "lgt"],
    lights: ["lamps", "lgts"],
    vertex: ["vert", "vtx"],
    vertices: ["verts", "vtxs"],
    triangle: ["tri"],
    triangles: ["tris"],
    quad: ["quadrilateral"],
    quads: ["quadrilaterals"],
    point: ["pt"],
    points: ["pts"],
    position: ["pos", "location"],
    positions: ["posns", "locations"],
    direction: ["dir"],
    directions: ["dirs"],
    normal: ["nrm"],
    normals: ["nrms"],
    tangent: ["tan"],
    tangents: ["tans"],
    texcoord: ["uv"],
    texcoords: ["uvs"],
    coordinate: ["coord"],
    coordinates: ["coords"],
    transform: ["xform"],
    transforms: ["xforms"],
    translation: ["offset"],
    rotation: ["rot"],
    scaling: ["scale"],
    orientation: ["orient"],
    width: ["w", "wd"],
    height: ["h", "ht"],
    length: ["len"],
    distance: ["dist"],
    radius: ["rad"],
    diameter: ["diam"],
    resolution: ["res"],
    dimensions: ["dims"],
    index: ["idx"],
    indices: ["idxs"],
    count: ["num", "tally"],
    number: ["num"],
    offset: ["ofs"],
    stride: ["step"],
    component: ["comp"],
    components: ["comps"],
    channel: ["chan", "ch"],
    channels: ["chans", "chs"],
    buffer: ["buf"],
    buffers: ["bufs"],
    memory: ["mem"],
    storage: ["store"],
    pointer: ["ptr"],
    address: ["addr"],
    source: ["src", "origin"],
    destination: ["dst", "target"],
    target: ["tgt", "destination"],
    input: ["in"],
    output: ["out"],
    result: ["res", "outcome"],
    value: ["val"],
    values: ["vals"],
    parameter: ["param", "arg"],
    parameters: ["params", "args"],
    params: ["parameters"],
    argument: ["arg"],
    arguments: ["args"],
    options: ["opts"],
    config: ["configuration", "cfg"],
    settings: ["options"],
    state: ["st"],
    sample: ["smp"],
    samples: ["smps"],
    weight: ["wt"],
    weights: ["wts"],
    probability: ["prob"],
    distribution: ["dist"],
    random: ["rnd"],
    seed: ["rng_seed"],
    generator: ["gen"],
    filter: ["flt"],
    intersect: ["isect"],
    intersection: ["isect"],
    intersections: ["isects"],
    primitive: ["prim"],
    primitives: ["prims"],
    subdivision: ["subdiv"],
    subdivide: ["refine"],
    segment: ["seg"],
    segments: ["segs"],
    curve: ["crv"],
    curves: ["crvs"],
    node: ["nd"],
    nodes: ["nds"],
    tree: ["hierarchy"],
    children: ["kids"],
    parent: ["par"],
    internal: ["inner"],
    external: ["outer"],
    minimum: ["min"],
    maximum: ["max"],
    previous: ["prev"],
    current: ["curr"],
    next: ["following"],
    start: ["beginning"],
    finish: ["end"],
    first: ["initial"],
    last: ["final"],
    error: ["err"],
    message: ["msg"],
    name: ["label"],
    filename: ["file_name"],
    path: ["pth"],
    progress: ["advancement"],
    render: ["draw"],
    renderer: ["render_engine"],
    trace: ["trc"],
    bounces: ["rebounds"],
    emission: ["emit"],
    roughness: ["rgh"],
    metallic: ["metalness"],
    opacity: ["opaqueness"],
  },
  affixes: {
    function: {
      prefixes: ["fn", "func", "routine", "call"],
      suffixes: ["fn", "func", "routine", "op"],
    },
    type: { prefixes: ["t", "type", "ty"], suffixes: ["t", "type", "ty", "form"] },
    field: {
      prefixes: ["m", "member", "field", "attr"],
      suffixes: ["member", "field", "attr", "value"],
    },
    local: { prefixes: ["v", "var", "local"], suffixes: ["v", "var", "local", "value"] },
    variable: { prefixes: ["g", "global", "var"], suffixes: ["var", "global", "value"] },
    parameter: { prefixes: ["p", "arg", "param"], suffixes: ["arg", "param", "argument"] },
  },
  forms: ["substitution", "prefix", "suffix", "mixed"],
  styles: ["snake", "camel", "pascal"],
};

const hash = (value) => createHash("sha256").update(value).digest("hex");
/** Version and content identity used to make naming assignments auditable outside the agent payload. */
export const vocabularyIdentity = {
  version: vocabulary.version,
  identity: hash(JSON.stringify(vocabulary)),
};
const number = (value) => Number.parseInt(hash(value).slice(0, 8), 16);
const wordsOf = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/_+/)
    .filter(Boolean);
const title = (word) => word[0].toUpperCase() + word.slice(1);
function spell(words, style) {
  if (style === "snake") return words.join("_");
  return words
    .map((word, index) => (index === 0 && style === "camel" ? word : title(word)))
    .join("");
}

/** Describe actual naming diversity by semantic family, without counting redeclarations twice. */
export function namingSummary(selection) {
  const families = [...new Map(selection.map((entry) => [entry.family, entry])).values()];
  const histogram = (key) =>
    Object.fromEntries(
      [...new Set(families.map(key))]
        .sort()
        .map((value) => [value, families.filter((entry) => key(entry) === value).length]),
    );
  const examples = [];
  for (const role of [...new Set(families.map((entry) => entry.role))].sort())
    for (const form of vocabulary.forms) {
      const entry = families.find((item) => item.role === role && item.form === form);
      if (entry)
        examples.push({
          role,
          form,
          name: entry.name,
          newName: entry.newName,
          substitutions: entry.substitutions,
        });
    }
  const repeated = [];
  for (const name of [...new Set(families.map((entry) => entry.name))].sort()) {
    const bindings = families.filter((entry) => entry.name === name);
    if (new Set(bindings.map((entry) => entry.newName)).size > 1)
      repeated.push({
        name,
        variants: [...new Set(bindings.map((entry) => entry.newName))].slice(0, 6),
      });
  }
  return {
    families: families.length,
    forms: histogram((entry) => entry.form),
    styles: histogram((entry) => entry.style),
    affixes: histogram((entry) => `${entry.prefix}:${entry.suffix}`),
    substitutedFamilies: families.filter((entry) => entry.substitutions.length > 0).length,
    examples,
    repeated: repeated.slice(0, 12),
  };
}
/** Assign deterministic, readable variants to semantic families, never individual text occurrences. */
export function assignNames(selection, sourceIdentifiers) {
  const families = new Map();
  const occupied = new Map();
  const familyScopes = new Map();
  for (const entry of selection) {
    const scopes = familyScopes.get(entry.family) ?? new Set();
    scopes.add(entry.scope);
    familyScopes.set(entry.family, scopes);
  }
  for (const entry of selection) {
    if (families.has(entry.family)) continue;
    const scopes = [...familyScopes.get(entry.family)];
    const used = scopes.map((scope) => {
      const names = occupied.get(scope) ?? new Set();
      occupied.set(scope, names);
      return names;
    });
    const seed = number(`${vocabulary.version}:${entry.family}`);
    const words = wordsOf(entry.name).map((word) => word.toLowerCase());
    const affixes = vocabulary.affixes[entry.role];
    for (let attempt = 0; attempt < 2048; attempt++) {
      const form = vocabulary.forms[(seed + attempt) % vocabulary.forms.length];
      const style = vocabulary.styles[Math.floor((seed + attempt) / 4) % vocabulary.styles.length];
      const substitutions = [];
      const stem = words.flatMap((word, index) => {
        const alternatives = vocabulary.words[word];
        if (!alternatives || (form !== "substitution" && (seed + attempt + index) % 3 === 0))
          return [word];
        const replacement =
          alternatives[number(`${entry.family}:${index}:${attempt}`) % alternatives.length];
        substitutions.push({ word, replacement });
        return replacement.split("_");
      });
      if (form === "substitution" && !substitutions.length) continue;
      const prefix = ["prefix", "mixed"].includes(form)
        ? affixes.prefixes[Math.floor((seed + attempt) / 12) % affixes.prefixes.length]
        : "";
      const suffix = ["suffix", "mixed"].includes(form)
        ? affixes.suffixes[Math.floor((seed + attempt) / 48) % affixes.suffixes.length]
        : "";
      const newName = spell(
        [...(prefix ? [prefix] : []), ...stem, ...(suffix ? [suffix] : [])],
        style,
      );
      if (
        newName === entry.name ||
        sourceIdentifiers.has(newName) ||
        used.some((names) => names.has(newName))
      )
        continue;
      const assignment = { newName, form, style, prefix, suffix, substitutions };
      families.set(entry.family, assignment);
      for (const names of used) names.add(newName);
      break;
    }
    if (!families.has(entry.family))
      throw new Error(`Naming vocabulary exhausted for ${entry.scope}:${entry.name}`);
  }
  return selection.map((entry) => ({ ...entry, ...families.get(entry.family) }));
}
