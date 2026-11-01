import assert from "node:assert/strict";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function resourcesOverlap(left, right) {
  if (left.file !== right.file) return false;
  if (left.range === undefined || right.range === undefined) return true;
  const [leftStart, leftEnd] = left.range;
  const [rightStart, rightEnd] = right.range;
  const start = Math.max(leftStart, rightStart);
  const end = Math.min(leftEnd, rightEnd);
  return leftStart === leftEnd || rightStart === rightEnd ? start <= end : start < end;
}

/** Select a deterministic maximal batch from already verified current footprints.
 * Omitted ranges reserve the whole file. Points also reserve both boundaries.
 * The caller owns snapshot consistency, attribution and feedback refresh.
 */
export function selectRecoveryBatch(candidates) {
  assert.ok(Array.isArray(candidates), "Missing recovery candidates");
  const ids = new Set();
  for (const candidate of candidates) {
    assert.ok(record(candidate), "Invalid recovery candidate");
    assert.ok(typeof candidate.id === "string" && candidate.id.length > 0, "Invalid repair id");
    assert.ok(!ids.has(candidate.id), "Duplicate repair id");
    ids.add(candidate.id);
    assert.ok(
      Number.isSafeInteger(candidate.owner) && candidate.owner >= 0 && candidate.owner < 10,
      "Invalid original repair owner",
    );
    assert.ok(
      Array.isArray(candidate.resources) && candidate.resources.length > 0,
      "Missing repair resources",
    );
    for (const resource of candidate.resources) {
      assert.ok(record(resource), "Invalid repair resource");
      assert.ok(
        typeof resource.file === "string" && resource.file.length > 0,
        "Invalid resource file",
      );
      if (resource.range !== undefined) {
        assert.ok(
          Array.isArray(resource.range) && resource.range.length === 2,
          "Invalid source range",
        );
        const [start, end] = resource.range;
        assert.ok(
          Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end,
          "Invalid source coordinates",
        );
      }
    }
  }
  const ready = [],
    deferred = [];
  for (const candidate of candidates) {
    const conflict = ready.some(
      (selected) =>
        selected.owner === candidate.owner ||
        selected.resources.some((left) =>
          candidate.resources.some((right) => resourcesOverlap(left, right)),
        ),
    );
    (conflict ? deferred : ready).push(candidate);
  }
  return { ready, deferred };
}
