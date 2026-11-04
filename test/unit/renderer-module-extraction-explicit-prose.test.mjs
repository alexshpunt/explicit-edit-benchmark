import assert from "node:assert/strict";
import test from "node:test";
import { explicitExtractionProse } from "../../src/suites/explicit-edit-multi-agent/extraction/explicit-prose.mjs";

test("explicit prose describes preservation, ordering, and header replacement without private payload", () => {
  const prose = explicitExtractionProse({
    kind: "header",
    file: "part.h",
    replacement: '#include "part.h"\n',
    fragments: [{ text: "private_function_body" }],
    destination: "private_destination",
  });
  for (const phrase of ["part.h", "outermost", "barrier", "comments", "macro", "unrelated"]) {
    assert.ok(prose.toLowerCase().includes(phrase), phrase);
  }
  assert.doesNotMatch(prose, /private_function_body|private_destination/);
});

test("isolated prose includes the assigned destination without exposing source fragments", () => {
  const prose = explicitExtractionProse(
    {
      kind: "header",
      file: "part.h",
      replacement: '#include "part.h"\n',
      fragments: [{ text: "private_function_body" }],
    },
    { sorted: true },
  );
  assert.ok(prose.includes("part.h"));
  assert.doesNotMatch(prose, /private_function_body/);
});

test("explicit prose distinguishes implementation and vendor source replacement", () => {
  assert.match(
    explicitExtractionProse({ kind: "implementation", replacement: "" }),
    /without inserting/i,
  );
  assert.match(
    explicitExtractionProse({
      kind: "vendor-header",
      file: "support/vendor.h",
      replacement: '#include "support/vendor.h"\n',
    }),
    /first removed/i,
  );
});
