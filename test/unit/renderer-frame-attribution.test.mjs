import assert from "node:assert/strict";
import { test } from "node:test";
import { createFrameAttribution } from "../../src/suites/explicit-edit-multi-agent/grading/frame-attribution.mjs";

const tokens = ["int", "renamed", "(", ")", "{", "return", "0", ";", "}"];
const owner = (changes = {}) => ({
  file: "api.h",
  scope: "frond",
  kind: "function",
  conditions: [],
  tokens,
  ids: new Set(["rename"]),
  slots: new Map([[1, {}]]),
  ...changes,
});

// Count token reads rather than wall time: a protected body can be arbitrarily
// large, but attribution only needs the masked declaration header.
function observed(values) {
  let reads = 0;
  return {
    tokens: new Proxy(values, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return target[key];
      },
    }),
    reads: () => reads,
  };
}

test("compiler matches retain all exact owners without fallback attribution", () => {
  const actual = owner({ tokens: ["damaged"] });
  const exact = [owner(), owner({ ids: new Set(["sibling"]) })];
  const lookup = createFrameAttribution([], new Map([[actual, exact]]));
  assert.strictEqual(lookup(actual), exact);
});

test("attribution retains duplicate assigned owners in endpoint order and excludes other shapes", () => {
  const first = owner();
  const second = owner({ ids: new Set(["second"]) });
  const expected = [
    owner({ file: "other.h" }),
    first,
    owner({ scope: "other" }),
    owner({ kind: "declaration" }),
    owner({ ids: new Set() }),
    owner({ conditions: ["#if OPTIONAL"] }),
    second,
  ];
  const actual = owner({ tokens: tokens.map((token) => (token === "renamed" ? "wrong" : token)) });
  assert.deepEqual(createFrameAttribution(expected, new Map())(actual), [first, second]);
});

for (const delimiter of ["{", "=", ";"]) {
  test(`a requested ${delimiter} token is masked before detecting the header boundary`, () => {
    const expected = owner();
    const actual = owner({
      tokens: tokens.map((token, index) => (index === 1 ? delimiter : token)),
    });
    assert.deepEqual(createFrameAttribution([expected], new Map())(actual), [expected]);
  });
}

test("different requested slot sets keep separate attribution obligations", () => {
  const first = owner();
  const second = owner({ slots: new Map([[0, {}]]), ids: new Set(["type"]) });
  const actual = owner({ tokens: ["int", "wrong", "(", ")", "{", "changed", "}"] });
  assert.deepEqual(createFrameAttribution([second, first], new Map())(actual), [first]);
});

test("an unmasked header change cannot inherit a nearby assigned owner", () => {
  const lookup = createFrameAttribution([owner()], new Map());
  for (const changed of [[], ["float", "wrong", "(", ")", "{"], ["int", "wrong", "("]])
    assert.deepEqual(lookup(owner({ tokens: changed })), []);
});

test("unterminated headers compare every remaining unmasked token", () => {
  const expected = owner({ tokens: ["int", "renamed"] });
  const lookup = createFrameAttribution([expected], new Map());
  assert.deepEqual(lookup(owner({ tokens: ["int", "wrong"] })), [expected]);
  assert.deepEqual(lookup(owner({ tokens: ["float", "wrong"] })), []);
  assert.deepEqual(lookup(owner({ tokens: ["int"] })), []);
});

test("attribution does not read protected function bodies or repeat candidate work", () => {
  const body = Array.from({ length: 10_000 }, () => "body");
  const expectedTokens = observed([...tokens.slice(0, 5), ...body, "}"]);
  const actualTokens = observed([...tokens.slice(0, 5), ...body, "damaged", "}"]);
  const expected = owner({ tokens: expectedTokens.tokens });
  const actual = owner({ tokens: actualTokens.tokens });
  const lookup = createFrameAttribution([expected], new Map());
  const found = lookup(actual);
  assert.deepEqual(found, [expected]);
  assert.ok(expectedTokens.reads() <= 5, `Expected header reads: ${expectedTokens.reads()}`);
  assert.ok(actualTokens.reads() <= 5, `Candidate header reads: ${actualTokens.reads()}`);
  const previous = actualTokens.reads();
  assert.strictEqual(lookup(actual), found);
  assert.equal(actualTokens.reads(), previous);
});

test("attribution caches are confined to one candidate evaluation", () => {
  const expected = owner();
  const first = owner({ tokens: ["int", "old", "(", ")", "{"] });
  const second = owner({ tokens: ["float", "old", "(", ")", "{"] });
  assert.deepEqual(createFrameAttribution([expected], new Map())(first), [expected]);
  assert.deepEqual(createFrameAttribution([expected], new Map())(second), []);
});
