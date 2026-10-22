import assert from "node:assert/strict";
import test from "node:test";
import { cppStructure } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-structure.mjs";

function units(source) {
  return cppStructure(source).units.map((unit) => ({
    text: source.slice(unit.start, unit.end),
    definition: unit.definition,
    scope: unit.scope,
  }));
}

test("class and typename function templates retain separate complete owners", () => {
  for (const keyword of ["class", "typename"]) {
    const first = `template<${keyword} T> void shared(T value) { sink(value); }`;
    const after = "void after() {}";
    assert.deepEqual(units(`${first}\n${after}\n`), [
      { text: first, definition: true, scope: "" },
      { text: after, definition: true, scope: "" },
    ]);
    assert.deepEqual(units(`namespace frond { ${first} }`), [
      { text: first, definition: true, scope: "frond" },
    ]);
  }
});

test("actual record templates still include their declaration terminators", () => {
  const records = [
    "template<class T> struct Box { T value; };",
    "template<typename T> class Other { T value; };",
    "template<class T> union Choice { T value; int other; };",
  ];
  const after = "void after() {}";
  assert.deepEqual(units([...records, after].join("\n")), [
    ...records.map((text) => ({ text, definition: false, scope: "" })),
    { text: after, definition: true, scope: "" },
  ]);
});

test("nested template parameters and type defaults stay in the function's owner", () => {
  const first =
    "template<template<class, class = Inner<int>> class Container = Box, class T = Outer<Inner<int>>> void shared(Container<T> value) { sink(value); }";
  const second = "template<class T, int N = (1 < 2 ? 3 : 4)> void counted(T value) {}";
  const after = "void after() {}";
  assert.deepEqual(units([first, second, after].join("\n")), [
    { text: first, definition: true, scope: "" },
    { text: second, definition: true, scope: "" },
    { text: after, definition: true, scope: "" },
  ]);
});

test("template specializations and comparison operators keep their own boundaries", () => {
  const first = "template<> void shared<int>(int value) { sink(value); }";
  const second = "template<class T> bool operator<(const T& a, const T& b) { return a.less(b); }";
  const after = "void after() {}";
  assert.deepEqual(units([first, second, after].join("\n")), [
    { text: first, definition: true, scope: "" },
    { text: second, definition: true, scope: "" },
    { text: after, definition: true, scope: "" },
  ]);
});

test("an unparenthesized angle expression in a non-type default rejects instead of guessing", () => {
  for (const expression of ["left < right", "left << right", "left >> right"]) {
    assert.throws(
      () => cppStructure(`template<int N = ${expression}> void shared() {}\nvoid after() {}`),
      /Unsupported template parameter default/,
    );
  }
});
