import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionSubmitOptions } from "../../scripts/benchmark-extension-submit.mjs";

await test("one extension submit fixes the requested arm and standard run policy", () => {
  assert.deepEqual(
    extensionSubmitOptions([
      "--extension",
      "pi-semantic-edit",
      "--auth-file",
      "/private/auth.json",
    ]),
    {
      extension: "pi-semantic-edit",
      authFile: "/private/auth.json",
      concurrency: 10,
      timeoutSeconds: 120,
    },
  );
  assert.deepEqual(
    extensionSubmitOptions([
      "--extension",
      "pi-lector",
      "--auth-file",
      "/private/auth.json",
      "--concurrency",
      "1",
      "--timeout-seconds",
      "900",
    ]),
    {
      extension: "pi-lector",
      authFile: "/private/auth.json",
      concurrency: 1,
      timeoutSeconds: 900,
    },
  );
});

await test("extension submit rejects an unknown arm or incomplete paid run", () => {
  assert.throws(
    () => extensionSubmitOptions(["--extension", "unknown", "--auth-file", "/private/auth.json"]),
    /Unknown Pi extension arm/u,
  );
  assert.throws(() => extensionSubmitOptions(["--extension", "pi-semantic-edit"]), /auth-file/u);
  assert.throws(
    () =>
      extensionSubmitOptions([
        "--extension",
        "pi-semantic-edit",
        "--auth-file",
        "/private/auth.json",
        "--concurrency",
        "0",
      ]),
    /concurrency/u,
  );
});
