import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function validate(items, slots, assignment) {
  assert.ok(Array.isArray(items) && Array.isArray(slots) && Array.isArray(assignment));
  assert.equal(items.length, slots.length);
  assert.equal(items.length, assignment.length);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.ok(
    items.every(
      (item) =>
        typeof item.id === "string" &&
        typeof item.owner === "string" &&
        Number.isFinite(item.origin) &&
        Number.isFinite(item.lower),
    ),
  );
  assert.ok(
    slots.every((slot, index) => Number.isFinite(slot) && (index === 0 || slots[index - 1] < slot)),
  );
  assert.ok(items.every((item, index) => item.origin === slots[index]));
  assert.ok(
    items.every(
      (item, index) =>
        Number.isSafeInteger(item.length ?? 1) &&
        (item.length ?? 1) > 0 &&
        (index + 1 === items.length || item.origin + (item.length ?? 1) <= slots[index + 1]),
    ),
  );
  assert.equal(new Set(assignment).size, items.length);
  for (const [slot, index] of assignment.entries()) {
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < items.length);
    assert.ok(slots[slot] >= items[index].lower);
    assert.equal(items[index].group ?? "", items[slot].group ?? "");
  }
}

const weight = (pairs) => (pairs ? Math.max(1, Math.floor(1_000_000 / pairs)) : 0);

// A moved definition changes every subsequent slot by its size difference.
function evaluate(items, slots, assignment) {
  const owners = new Map();
  let displacement = 0,
    crossSource = 0,
    moved = 0,
    shift = 0;
  for (const [slot, index] of assignment.entries()) {
    const item = items[index],
      position = slots[slot] + shift;
    shift += (item.length ?? 1) - (items[slot].length ?? 1);
    displacement += Math.abs(position - item.origin);
    if (item.owner !== items[slot].owner) crossSource++;
    if (index !== slot) moved++;
    if (!owners.has(item.owner)) owners.set(item.owner, { count: 0, sum: 0, distance: 0 });
    const row = owners.get(item.owner);
    row.distance += position * row.count - row.sum;
    row.sum += position;
    row.count++;
  }
  let dispersion = 0;
  const sources = [...owners]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, row]) => {
      const pairs = (row.count * (row.count - 1)) / 2;
      dispersion += row.distance * weight(pairs);
      return { owner, distance: row.distance, pairs };
    });
  return { dispersion, displacement, crossSource, moved, sources };
}

/** Score final positions, including shifts from definitions of different lengths. */
export function shuffleMetrics(items, slots, assignment) {
  validate(items, slots, assignment);
  return evaluate(items, slots, assignment);
}

// The delta formulas use integer arithmetic in a different order from evaluate().
// For non-integer or large inputs, retain the existing evaluation exactly.
function safeDeltas(items, slots) {
  if (
    items.some((item) => !Number.isSafeInteger(item.origin) || Object.is(item.origin, -0)) ||
    slots.some((slot) => !Number.isSafeInteger(slot) || Object.is(slot, -0))
  )
    return false;
  const count = BigInt(items.length);
  let max = 0n,
    lengths = 0n;
  const owners = new Map();
  for (const item of items) {
    const origin = BigInt(item.origin);
    max = (origin < 0n ? -origin : origin) > max ? (origin < 0n ? -origin : origin) : max;
    lengths += BigInt(item.length ?? 1);
    owners.set(item.owner, (owners.get(item.owner) ?? 0) + 1);
  }
  const span = 2n * (max + lengths + 1n);
  let total = span * (count + 1n) * (count + 1n);
  for (const n of owners.values()) {
    const pairs = (n * (n - 1)) / 2;
    total += span * BigInt(pairs) * BigInt(weight(pairs));
  }
  // Allow for intermediate sums and subtractions in both scoring paths.
  return total * 8n <= BigInt(Number.MAX_SAFE_INTEGER);
}

// Prepare prefix counts and position sums once per search pass. Swapping i/j
// changes owner membership only at those ends. A length difference translates
// positions (i, j]; the other positions stay fixed. For each owner, a uniform
// translation contributes d * inside * (left - right) to pair distances.
function prepareSwapScores(items, slots, assignment, score) {
  const n = items.length,
    sources = score.sources,
    byOwner = new Map();
  for (const [index, source] of sources.entries()) byOwner.set(source.owner, index);
  const owners = assignment.map((index) => byOwner.get(items[index].owner));
  const counts = sources.map(() => new Float64Array(n + 1));
  const sums = sources.map(() => new Float64Array(n + 1));
  const positions = Array(n);
  let shift = 0;
  for (let index = 0; index < n; index++) {
    positions[index] = slots[index] + shift;
    shift += (items[assignment[index]].length ?? 1) - (items[index].length ?? 1);
    for (let owner = 0; owner < sources.length; owner++) {
      counts[owner][index + 1] = counts[owner][index];
      sums[owner][index + 1] = sums[owner][index];
    }
    counts[owners[index]][index + 1]++;
    sums[owners[index]][index + 1] += positions[index];
  }
  function distanceTo(owner, index) {
    const position = positions[index],
      leftCount = counts[owner][index],
      leftSum = sums[owner][index];
    return (
      position * leftCount -
      leftSum +
      sums[owner][n] -
      leftSum -
      position * (counts[owner][n] - leftCount)
    );
  }
  return (i, j, reject = () => false) => {
    const left = items[assignment[i]],
      right = items[assignment[j]];
    const a = owners[i],
      b = owners[j],
      change = (right.length ?? 1) - (left.length ?? 1);
    const gap = positions[j] - positions[i],
      sourcesAfter = [];
    let dispersion = 0;
    for (let owner = 0; owner < sources.length; owner++) {
      let delta = 0;
      if (a !== b && owner === a) delta += distanceTo(owner, j) - distanceTo(owner, i) - gap;
      if (a !== b && owner === b) delta += distanceTo(owner, i) - distanceTo(owner, j) - gap;
      let leftCount = counts[owner][i + 1];
      let middleCount = counts[owner][j + 1] - leftCount;
      const rightCount = counts[owner][n] - counts[owner][j + 1];
      if (a !== b && owner === a) {
        leftCount--;
        middleCount++;
      }
      if (a !== b && owner === b) {
        leftCount++;
        middleCount--;
      }
      delta += change * middleCount * (leftCount - rightCount);
      const row = sources[owner];
      const next = { owner: row.owner, distance: row.distance + delta, pairs: row.pairs };
      sourcesAfter.push(next);
      dispersion += next.distance * weight(next.pairs);
    }
    const crossSource =
      score.crossSource +
      Number(right.owner !== items[i].owner) +
      Number(left.owner !== items[j].owner) -
      Number(left.owner !== items[i].owner) -
      Number(right.owner !== items[j].owner);
    const moved =
      score.moved +
      Number(assignment[j] !== i) +
      Number(assignment[i] !== j) -
      Number(assignment[i] !== i) -
      Number(assignment[j] !== j);
    if (reject({ dispersion, crossSource, moved, sources: sourcesAfter })) return null;
    let displacement =
      score.displacement +
      Math.abs(positions[i] - right.origin) -
      Math.abs(positions[i] - left.origin) +
      Math.abs(positions[j] + change - left.origin) -
      Math.abs(positions[j] - right.origin);
    for (let k = i + 1; k < j; k++) {
      const origin = items[assignment[k]].origin;
      displacement += Math.abs(positions[k] + change - origin) - Math.abs(positions[k] - origin);
    }
    return { dispersion, displacement, crossSource, moved, sources: sourcesAfter };
  };
}

/** Evaluate one legal swap using the same exact final-coordinate metrics. */
export function shuffleSwapMetrics(items, slots, assignment, i, j) {
  validate(items, slots, assignment);
  assert.ok(
    Number.isSafeInteger(i) && Number.isSafeInteger(j) && 0 <= i && i < j && j < slots.length,
  );
  const swapped = [...assignment];
  [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
  validate(items, slots, swapped);
  if (!safeDeltas(items, slots)) return evaluate(items, slots, swapped);
  return prepareSwapScores(items, slots, assignment, evaluate(items, slots, assignment))(i, j);
}

const better = (left, right, priority) => {
  const fields =
    priority === "cross-source"
      ? ["crossSource", "dispersion", "moved", "displacement"]
      : priority === "moved"
        ? ["moved", "dispersion", "crossSource", "displacement"]
        : ["dispersion", "crossSource", "moved", "displacement"];
  for (const field of fields) if (left[field] !== right[field]) return left[field] > right[field];
  return false;
};

// Exact assignment bound within each fixed region, ignoring the additional
// per-owner dispersion floor. Minimize same-owner or unchanged-slot assignments.
function feasibleBound(items, slots, slotGroups, mode) {
  const regions = new Map();
  for (const [slot, group] of slotGroups.entries()) {
    if (!regions.has(group)) regions.set(group, []);
    regions.get(group).push(slot);
  }
  let totalMoved = 0;
  for (const positions of regions.values()) {
    const n = positions.length,
      forbidden = n + 1;
    const u = Array(n + 1).fill(0),
      v = Array(n + 1).fill(0),
      match = Array(n + 1).fill(0),
      previous = Array(n + 1).fill(0);
    for (let row = 1; row <= n; row++) {
      match[0] = row;
      let column = 0;
      const minimum = Array(n + 1).fill(Infinity),
        used = Array(n + 1).fill(false);
      do {
        used[column] = true;
        const current = match[column];
        let delta = Infinity,
          next = 0;
        for (let col = 1; col <= n; col++) {
          if (used[col]) continue;
          const item = items[positions[current - 1]],
            target = positions[col - 1];
          const same =
            mode === "cross"
              ? item.owner === items[target].owner
              : positions[current - 1] === target;
          const cost = slots[target] < item.lower ? forbidden : Number(same);
          const reduced = cost - u[current] - v[col];
          if (reduced < minimum[col]) {
            minimum[col] = reduced;
            previous[col] = column;
          }
          if (minimum[col] < delta) {
            delta = minimum[col];
            next = col;
          }
        }
        assert.ok(Number.isFinite(delta));
        for (let col = 0; col <= n; col++) {
          if (used[col]) {
            u[match[col]] += delta;
            v[col] -= delta;
          } else minimum[col] -= delta;
        }
        column = next;
      } while (match[column] !== 0);
      do {
        const before = previous[column];
        match[column] = match[before];
        column = before;
      } while (column !== 0);
    }
    for (let col = 1; col <= n; col++) {
      const item = items[positions[match[col] - 1]],
        target = positions[col - 1];
      assert.ok(slots[target] >= item.lower);
      const same =
        mode === "cross"
          ? item.owner === items[target].owner
          : positions[match[col] - 1] === target;
      if (!same) totalMoved++;
    }
  }
  return totalMoved;
}
/** Improve a known-valid assignment using deterministic, feasibility-preserving swaps. */
export function optimizeShuffle(
  items,
  slots,
  initial,
  { seed = "renderer-function-mix-v1", restarts = 8, passes = 64, priority = "dispersion" } = {},
) {
  validate(items, slots, initial);
  assert.equal(typeof seed, "string");
  assert.ok(["dispersion", "cross-source", "moved"].includes(priority));
  assert.ok(Number.isSafeInteger(restarts) && restarts >= 0 && restarts <= 64);
  assert.ok(Number.isSafeInteger(passes) && passes >= 0 && passes <= 1000);
  let best = [...initial],
    bestScore = shuffleMetrics(items, slots, best);
  const slotGroups = initial.map((index) => items[index].group ?? "");
  // Upper bound ignores dependency lower bounds and per-owner fairness.
  const groups = new Map();
  for (const item of items) {
    const group = item.group ?? "";
    if (!groups.has(group)) groups.set(group, new Map());
    const counts = groups.get(group);
    counts.set(item.owner, (counts.get(item.owner) ?? 0) + 1);
  }
  let crossUpperBound = 0;
  for (const counts of groups.values()) {
    const sizes = [...counts.values()],
      total = sizes.reduce((sum, count) => sum + count, 0);
    crossUpperBound += Math.min(total, 2 * (total - Math.max(...sizes)));
  }
  const crossFeasibleUpperBound = feasibleBound(items, slots, slotGroups, "cross");
  const moveFeasibleUpperBound = feasibleBound(items, slots, slotGroups, "move");
  const minimum = new Map(bestScore.sources.map((row) => [row.owner, row.distance]));
  const candidates = [best];
  for (let attempt = 0; attempt < restarts; attempt++) {
    const remaining = items
      .map((item, index) => ({ index, key: hash(`${seed}:${attempt}:${item.id}`) }))
      .sort((left, right) => left.key.localeCompare(right.key));
    const assignment = [];
    for (const [position, slot] of slots.entries()) {
      const pick = remaining.findIndex(
        ({ index }) =>
          (items[index].group ?? "") === slotGroups[position] && items[index].lower <= slot,
      );
      assert.ok(pick >= 0);
      assignment.push(remaining.splice(pick, 1)[0].index);
    }
    candidates.push(assignment);
  }
  const useDeltas = safeDeltas(items, slots);
  let swaps = 0;
  const attempts = [];
  for (const [candidateIndex, initialCandidate] of candidates.entries()) {
    const assignment = [...initialCandidate];
    let score = shuffleMetrics(items, slots, assignment);
    let used = 0,
      converged = false;
    for (let pass = 0; pass < passes; pass++) {
      let move = null,
        next = score;
      const swapScore = useDeltas ? prepareSwapScores(items, slots, assignment, score) : null;
      for (let i = 0; i < slots.length; i++)
        for (let j = i + 1; j < slots.length; j++) {
          const left = items[assignment[i]],
            right = items[assignment[j]];
          if (slotGroups[i] !== slotGroups[j] || slots[i] < right.lower || slots[j] < left.lower)
            continue;
          let proposed;
          if (swapScore)
            proposed = swapScore(i, j, (candidate) => {
              if (
                candidateIndex === 0 &&
                candidate.sources.some((row) => row.distance < minimum.get(row.owner))
              )
                return true;
              const fields =
                priority === "cross-source"
                  ? ["crossSource", "dispersion", "moved"]
                  : priority === "moved"
                    ? ["moved", "dispersion", "crossSource"]
                    : ["dispersion", "crossSource", "moved"];
              for (const field of fields)
                if (candidate[field] !== next[field]) return candidate[field] < next[field];
              return false;
            });
          else {
            [assignment[i], assignment[j]] = [assignment[j], assignment[i]];
            proposed = evaluate(items, slots, assignment);
            [assignment[i], assignment[j]] = [assignment[j], assignment[i]];
          }
          if (!proposed) continue;
          if (
            candidateIndex === 0 &&
            proposed.sources.some((row) => row.distance < minimum.get(row.owner))
          )
            continue;
          if (better(proposed, next, priority)) {
            next = proposed;
            move = [i, j];
          }
        }
      if (!move) {
        converged = true;
        break;
      }
      const [i, j] = move;
      [assignment[i], assignment[j]] = [assignment[j], assignment[i]];
      score = next;
      swaps++;
      used++;
    }
    assert.deepEqual(shuffleMetrics(items, slots, assignment), score);
    const fair = score.sources.every((row) => row.distance >= minimum.get(row.owner));
    attempts.push({ swaps: used, converged, fair });
    if (fair && better(score, bestScore, priority)) {
      best = assignment;
      bestScore = score;
    }
  }
  return {
    assignment: best,
    metrics: bestScore,
    search: {
      priority,
      restarts,
      passes,
      swaps,
      attempts,
      crossUpperBound,
      crossFeasibleUpperBound,
      moveFeasibleUpperBound,
    },
  };
}
