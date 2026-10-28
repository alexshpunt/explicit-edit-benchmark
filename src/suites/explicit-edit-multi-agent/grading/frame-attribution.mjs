const shapeKey = (frame) => JSON.stringify([frame.file, frame.scope, frame.kind, frame.conditions]);
const delimiter = (token) => token === "{" || token === "=" || token === ";";

function maskedHeader(tokens, slots) {
  const result = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = slots.has(index) ? null : tokens[index];
    if (delimiter(token)) break;
    result.push(token);
  }
  return result;
}

function matchesHeader(tokens, header, slots) {
  for (let index = 0; index < header.length; index++) {
    if (index >= tokens.length) return false;
    const token = slots.has(index) ? null : tokens[index];
    if (token !== header[index]) return false;
  }
  const end = header.length;
  return end === tokens.length || (!slots.has(end) && delimiter(tokens[end]));
}

// Attribution identifies failed owners; it never establishes credit. Frames and
// compiler matches belong to one immutable candidate evaluation. Mask requested
// slots before finding delimiters, including malformed names such as "{".
export function createFrameAttribution(expected, reverse) {
  const byShape = new Map();
  for (const frame of expected) {
    if (!frame.ids.size) continue;
    const key = shapeKey(frame);
    if (!byShape.has(key)) byShape.set(key, []);
    byShape.get(key).push({ frame, header: maskedHeader(frame.tokens, frame.slots) });
  }
  const cache = new Map();
  return (frame) => {
    const exact = reverse.get(frame) ?? [];
    if (exact.length) return exact;
    if (!cache.has(frame)) {
      const owners = [];
      for (const other of byShape.get(shapeKey(frame)) ?? []) {
        if (matchesHeader(frame.tokens, other.header, other.frame.slots)) owners.push(other.frame);
      }
      cache.set(frame, owners);
    }
    return cache.get(frame);
  };
}
