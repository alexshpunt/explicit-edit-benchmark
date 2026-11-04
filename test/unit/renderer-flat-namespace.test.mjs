import test from "node:test";
import assert from "node:assert/strict";
import { flattenRendererNamespaces } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-namespace.mjs";

test("flatten project namespaces and keep standard hash specialization bindings", () => {
  const source =
    'namespace frond { struct V {}; }\nnamespace std { template <> struct hash<frond::V> {}; }\nusing namespace frond;\nfrond::V v;\nconst char *s = "frond::V";\n';
  const { text } = flattenRendererNamespaces(source, "frond");
  assert.match(text, /struct V \{\};/);
  assert.match(text, /struct std::hash<V>/);
  assert.match(text, /V v;/);
  assert.match(text, /"frond::V"/);
  assert.doesNotMatch(text, /namespace (?:frond|std)\s*\{/);
});

test("reject unrecognized declarations in the standard namespace", () => {
  assert.throws(() => flattenRendererNamespaces("namespace std { int x; }\n", "frond"));
});

test("reject project namespace references inside preprocessing directives", () => {
  assert.throws(() => flattenRendererNamespaces("#define V frond::V\n", "frond"));
});
