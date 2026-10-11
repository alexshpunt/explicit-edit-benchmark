# Earlier renderer experiments

For the current benchmark, use `npm run benchmark:multi-agent` and the
[Multi-Agent run guide](../../../docs/multi-agent.md).

This directory keeps earlier pilot, slice and grouped commands, their report
rebuilders and helpers used only by those routes. They are not alternative ways
to run or export the current candidate. Their reports retain their original
protocols; do not relabel them as current Multi-Agent results.

The [renderer technical guide](../../../docs/renderer.md) documents these routes.
`pilot.mjs --help` lists the eleven-request pilot's modes. Live commands spend
model credit and require separate approval. Keep credentials, generated source
and raw evidence outside Git, and use new output directories.

Shared generation, C++ analysis, reference editing and grading code remains in
`src/suites/explicit-edit-multi-agent/`. In particular, clean candidate preparation
still needs the full and coherent reference routes. Do not move those here merely
because they predate concurrent runs.

Alternate slice executors provide `reference/scripted-worker.mjs` and
`cpp/cpp-tokens.mjs`. Only those two files are staged into the isolated executor.
Preparation hashes both the shared suite and this directory's modules, so moving
or changing implementation requires a new pilot preparation.
