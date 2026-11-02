import assert from "node:assert/strict";
import test from "node:test";
import {
  optimizeShuffle,
  shuffleMetrics,
  shuffleSwapMetrics,
} from "../../src/suites/explicit-edit-multi-agent/generation/shuffle-optimization.mjs";

const items = [
  { id: "a0", owner: "a.cpp", origin: 0, lower: 0 },
  { id: "a1", owner: "a.cpp", origin: 1, lower: 0 },
  { id: "b0", owner: "b.cpp", origin: 2, lower: 0 },
  { id: "b1", owner: "b.cpp", origin: 3, lower: 0 },
];
const slots = [0, 1, 2, 3];
const clustered = [2, 3, 0, 1];

test("shuffle spreads each source file instead of moving it as a cluster", () => {
  const before = shuffleMetrics(items, slots, clustered);
  const result = optimizeShuffle(items, slots, clustered, { seed: "fixed" });
  const after = shuffleMetrics(items, slots, result.assignment);
  assert.ok(after.dispersion > before.dispersion);
  assert.equal(after.dispersion, 4_000_000);
  assert.ok(after.displacement > 0);
  assert.deepEqual(optimizeShuffle(items, slots, clustered, { seed: "fixed" }), result);
  assert.deepEqual(
    [...result.assignment].sort((a, b) => a - b),
    [0, 1, 2, 3],
  );
});

test("shuffle never crosses independent declaration or preprocessor regions", () => {
  const grouped = items.map((item, index) => ({ ...item, group: index < 2 ? "first" : "second" }));
  const initial = [0, 1, 2, 3];
  const result = optimizeShuffle(grouped, slots, initial, { seed: "groups" });
  assert.ok(result.assignment.slice(0, 2).every((index) => index < 2));
  assert.ok(result.assignment.slice(2).every((index) => index >= 2));
});
test("equally dispersed assignments favor moving every feasible definition", () => {
  const three = items.slice(0, 3).map((item) => ({ ...item, owner: "same.cpp" }));
  const threeSlots = [0, 1, 2];
  const result = optimizeShuffle(three, threeSlots, [0, 1, 2], { seed: "all-move", restarts: 0 });
  assert.equal(result.metrics.moved, 3);
  assert.equal(result.search.moveFeasibleUpperBound, 3);
  const movedFirst = optimizeShuffle(three, threeSlots, [0, 1, 2], {
    seed: "all-move",
    restarts: 0,
    priority: "moved",
  });
  assert.equal(movedFirst.metrics.moved, 3);
});
test("cross-source search spreads units without reducing either file's dispersion", () => {
  const initial = [0, 1, 2, 3];
  const before = shuffleMetrics(items, slots, initial);
  const result = optimizeShuffle(items, slots, initial, {
    seed: "cross",
    priority: "cross-source",
  });
  assert.equal(result.metrics.crossSource, 4);
  assert.equal(result.search.crossUpperBound, 4);
  assert.ok(result.metrics.dispersion >= before.dispersion);
  assert.deepEqual(
    optimizeShuffle(items, slots, initial, { seed: "cross", priority: "cross-source" }),
    result,
  );
});
test("cross-source upper bound accounts for dependency lower bounds", () => {
  const constrained = items.map((item, index) => ({ ...item, lower: index === 3 ? 3 : 0 }));
  const result = optimizeShuffle(constrained, slots, [0, 1, 2, 3], {
    seed: "bound-upper",
    priority: "cross-source",
  });
  assert.equal(result.search.crossUpperBound, 4);
  assert.equal(result.search.crossFeasibleUpperBound, 2);
  assert.equal(result.search.moveFeasibleUpperBound, 3);
  assert.equal(result.metrics.crossSource, 2);
});
test("feasible crossing bound agrees with exhaustive assignments", () => {
  function permutations(values) {
    if (values.length === 0) return [[]];
    return values.flatMap((value, index) =>
      permutations(values.filter((_, at) => at !== index)).map((rest) => [value, ...rest]),
    );
  }
  const all = permutations([0, 1, 2, 3]);
  for (let bits = 0; bits < 64; bits++) {
    const sample = items.map((item, index) => ({
      ...item,
      owner: (bits >> index) & 1 ? "a" : "b",
      lower: (bits >> (index + 2)) & 1 ? index : 0,
    }));
    const feasible = all.filter((order) =>
      order.every((item, at) => slots[at] >= sample[item].lower),
    );
    const expected = Math.max(
      ...feasible.map((order) => shuffleMetrics(sample, slots, order).crossSource),
    );
    const actual = optimizeShuffle(sample, slots, [0, 1, 2, 3], {
      seed: "exhaustive",
      restarts: 0,
      passes: 0,
    });
    assert.equal(actual.search.crossFeasibleUpperBound, expected);
    const maximumMoved = Math.max(
      ...feasible.map((order) => order.filter((item, at) => item !== at).length),
    );
    assert.equal(actual.search.moveFeasibleUpperBound, maximumMoved);
    assert.ok(actual.search.crossUpperBound >= expected);
  }
});
test("dispersion uses final positions after moving unequal-length definitions", () => {
  const unequal = items.map((item, index) => ({ ...item, length: index === 3 ? 100 : 1 }));
  const spread = shuffleMetrics(unequal, slots, [0, 3, 1, 2]);
  const collapsed = shuffleMetrics(unequal, slots, [3, 0, 2, 1]);
  assert.equal(spread.sources.find((row) => row.owner === "a.cpp").distance, 101);
  assert.equal(collapsed.sources.find((row) => row.owner === "a.cpp").distance, 2);
  const optimized = optimizeShuffle(unequal, slots, [0, 3, 1, 2], { seed: "lengths" });
  for (const row of spread.sources)
    assert.ok(
      optimized.metrics.sources.find((item) => item.owner === row.owner).distance >= row.distance,
    );
});

test("final positions match physically reordered unequal byte spans and fixed gaps", () => {
  const chunks = ["AA", "BBBBB", "C", "DDD"],
    gaps = [".", "..", "...", ""];
  const locations = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    locations.push(cursor);
    cursor += chunks[i].length + gaps[i].length;
  }
  const data = chunks.map((chunk, index) => ({
    id: String(index),
    owner: index % 2 ? "odd" : "even",
    origin: locations[index],
    length: Buffer.byteLength(chunk),
    lower: 0,
  }));
  function permutations(values) {
    return values.length
      ? values.flatMap((item, index) =>
          permutations(values.filter((_, at) => at !== index)).map((rest) => [item, ...rest]),
        )
      : [[]];
  }
  for (const order of permutations([0, 1, 2, 3])) {
    const output = order.map((item, index) => chunks[item] + gaps[index]).join("");
    const positions = chunks.map((chunk) => output.indexOf(chunk));
    const metrics = shuffleMetrics(data, locations, order);
    const distance = (owner) => {
      const values = data
        .map((item, index) => (item.owner === owner ? positions[index] : null))
        .filter((value) => value !== null);
      return Math.abs(values[1] - values[0]);
    };
    assert.equal(metrics.sources.find((row) => row.owner === "even").distance, distance("even"));
    assert.equal(metrics.sources.find((row) => row.owner === "odd").distance, distance("odd"));
    assert.equal(
      metrics.displacement,
      positions.reduce((sum, value, index) => sum + Math.abs(value - locations[index]), 0),
    );
  }
});
test("fast swap scores equal full physical evaluation for every legal pair", () => {
  const texts = ["λ", "bbb", "😀x", "q", "界界", "abcdef", "z", "🐈a"];
  const gaps = [" ", "///", "", "  ", "x", "", "##", ""];
  const starts = [];
  let cursor = 0;
  for (let index = 0; index < texts.length; index++) {
    starts.push(cursor);
    cursor += Buffer.byteLength(texts[index]) + Buffer.byteLength(gaps[index]);
  }
  const data = texts.map((value, index) => ({
    id: `id${index}`,
    origin: starts[index],
    length: Buffer.byteLength(value),
    owner: ["A", "B", "A", "C", "B", "C", "A", "B"][index],
    group: index < 4 ? "left" : "right",
    lower: 0,
  }));
  const assignments = [
    [0, 1, 2, 3, 4, 5, 6, 7],
    [3, 2, 1, 0, 7, 6, 5, 4],
    [1, 3, 0, 2, 5, 7, 4, 6],
    [2, 0, 3, 1, 6, 4, 7, 5],
    [0, 3, 2, 1, 4, 7, 6, 5],
  ];
  for (const order of assignments) {
    for (let i = 0; i < order.length; i++)
      for (let j = i + 1; j < order.length; j++) {
        if (data[i].group !== data[j].group) continue;
        const after = [...order];
        [after[i], after[j]] = [after[j], after[i]];
        assert.deepEqual(
          shuffleSwapMetrics(data, starts, order, i, j),
          shuffleMetrics(data, starts, after),
        );
      }
  }
});
test("swap scoring rejects invalid indices, boundaries and lower bounds", () => {
  const grouped = items.map((item, index) => ({
    ...item,
    group: index < 2 ? "left" : "right",
    lower: index === 3 ? 3 : 0,
  }));
  const initial = [0, 1, 2, 3];
  assert.throws(() => shuffleSwapMetrics(grouped, slots, initial, 0, 2));
  assert.throws(() => shuffleSwapMetrics(grouped, slots, initial, 2, 3));
  assert.throws(() => shuffleSwapMetrics(grouped, slots, initial, 1, 1));
  assert.throws(() => shuffleSwapMetrics(grouped, slots, initial, 2, 1));
});
test("delta scores match full scoring for seeded inputs and safe numeric fallbacks", () => {
  let state = 23945;
  const random = (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  for (let trial = 0; trial < 35; trial++) {
    const slots = [],
      data = [];
    let cursor = 10;
    for (let index = 0; index < 9; index++) {
      const length = 1 + random(20),
        group = String(Math.floor(index / 3));
      slots.push(cursor);
      const lower = trial % 3 === 0 ? cursor - random(5) : slots[Math.floor(index / 3) * 3];
      data.push({
        id: String(index),
        owner: `owner${random(4)}`,
        group,
        origin: cursor,
        length,
        lower,
      });
      cursor += length + random(8);
    }
    const order = data.map((_, index) => index);
    for (let step = 0; step < 15; step++) {
      const i = random(order.length),
        j = Math.floor(i / 3) * 3 + random(3);
      if (slots[i] < data[order[j]].lower || slots[j] < data[order[i]].lower) continue;
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let i = 0; i < order.length; i++)
      for (let j = i + 1; j < order.length; j++) {
        if (
          data[i].group !== data[j].group ||
          slots[i] < data[order[j]].lower ||
          slots[j] < data[order[i]].lower
        )
          continue;
        const after = [...order];
        [after[i], after[j]] = [after[j], after[i]];
        assert.deepEqual(
          shuffleSwapMetrics(data, slots, order, i, j),
          shuffleMetrics(data, slots, after),
        );
      }
  }
  for (const slots of [
    [0.25, 3.5, 9.5],
    [8_000_000_000_000_000, 8_000_000_000_000_004, 8_000_000_000_000_008],
  ]) {
    const data = slots.map((origin, index) => ({
      id: String(index),
      owner: index === 1 ? "b" : "a",
      origin,
      lower: -1,
    }));
    const initial = [0, 1, 2],
      after = [2, 1, 0];
    assert.deepEqual(
      shuffleSwapMetrics(data, slots, initial, 0, 2),
      shuffleMetrics(data, slots, after),
    );
  }
});

test("optimized complete search agrees with an independent brute-force swap search", () => {
  function better(left, right, priority) {
    const fields =
      priority === "cross-source"
        ? ["crossSource", "dispersion", "moved", "displacement"]
        : priority === "moved"
          ? ["moved", "dispersion", "crossSource", "displacement"]
          : ["dispersion", "crossSource", "moved", "displacement"];
    for (const field of fields) if (left[field] !== right[field]) return left[field] > right[field];
    return false;
  }
  let state = 9182;
  const random = (n) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % n;
  };
  for (let trial = 0; trial < 25; trial++) {
    const data = [],
      slots = [];
    let cursor = 0;
    for (let index = 0; index < 7; index++) {
      const length = 1 + random(12);
      slots.push(cursor);
      data.push({
        id: String(index),
        owner: `owner${random(3)}`,
        group: index < 4 ? "a" : "b",
        origin: cursor,
        length,
        lower: 0,
      });
      cursor += length + random(4);
    }
    const initial = data.map((_, index) => index);
    for (const priority of ["dispersion", "cross-source", "moved"]) {
      const assignment = [...initial],
        floor = new Map(
          shuffleMetrics(data, slots, initial).sources.map((row) => [row.owner, row.distance]),
        );
      let score = shuffleMetrics(data, slots, assignment),
        used = 0,
        converged = false;
      for (let pass = 0; pass < 8; pass++) {
        let next = score,
          move = null;
        for (let i = 0; i < assignment.length; i++)
          for (let j = i + 1; j < assignment.length; j++) {
            if (
              data[i].group !== data[j].group ||
              slots[i] < data[assignment[j]].lower ||
              slots[j] < data[assignment[i]].lower
            )
              continue;
            const trial = [...assignment];
            [trial[i], trial[j]] = [trial[j], trial[i]];
            const proposed = shuffleMetrics(data, slots, trial);
            if (proposed.sources.some((row) => row.distance < floor.get(row.owner))) continue;
            if (better(proposed, next, priority)) {
              next = proposed;
              move = [i, j];
            }
          }
        if (!move) {
          converged = true;
          break;
        }
        [assignment[move[0]], assignment[move[1]]] = [assignment[move[1]], assignment[move[0]]];
        score = next;
        used++;
      }
      const actual = optimizeShuffle(data, slots, initial, {
        seed: "oracle",
        priority,
        restarts: 0,
        passes: 8,
      });
      assert.deepEqual(actual.assignment, assignment);
      assert.deepEqual(actual.metrics, score);
      assert.deepEqual(actual.search.attempts, [{ swaps: used, converged, fair: true }]);
    }
  }
});
test("initial assignments may not cross compatibility groups", () => {
  const grouped = items.map((item, index) => ({ ...item, group: index < 2 ? "left" : "right" }));
  assert.throws(() => optimizeShuffle(grouped, slots, [2, 1, 0, 3], { seed: "invalid" }));
});
test("larger source files cannot reduce the dispersion of a smaller file", () => {
  const uneven = [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `large${index}`,
      owner: "large.cpp",
      origin: index,
      lower: 0,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `small${index}`,
      owner: "small.cpp",
      origin: index + 6,
      lower: 0,
    })),
  ];
  const locations = [0, 1, 2, 3, 4, 5, 6, 7],
    initial = [6, 0, 1, 2, 3, 4, 5, 7];
  const result = optimizeShuffle(uneven, locations, initial, { seed: "uneven" });
  const pair = (assignment) =>
    assignment
      .map((item, position) => ({ owner: uneven[item].owner, position: locations[position] }))
      .filter((row) => row.owner === "small.cpp")
      .map((row) => row.position);
  const before = pair(initial),
    after = pair(result.assignment);
  assert.ok(Math.abs(after[1] - after[0]) >= Math.abs(before[1] - before[0]));
});
test("shuffle preserves every lower bound and refuses invalid input", () => {
  const constrained = items.map((item, index) => ({ ...item, lower: index === 3 ? 2 : 0 }));
  const initial = [0, 1, 2, 3];
  const result = optimizeShuffle(constrained, slots, initial, { seed: "bound" });
  for (const [index, item] of result.assignment.entries())
    assert.ok(slots[index] >= constrained[item].lower);
  assert.throws(() => optimizeShuffle(constrained, slots, [3, 0, 1, 2], { seed: "bound" }));
  assert.throws(() => optimizeShuffle(items, slots, [0, 0, 2, 3], { seed: "bound" }));
});
