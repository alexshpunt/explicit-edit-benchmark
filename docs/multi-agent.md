# Explicit Edit — Multi-Agent

Multi-Agent is a separate benchmark candidate in the Explicit Edit repository.
It measures reliable editing of an existing large project by agents working
concurrently in one shared workspace. It is not a collection of unrelated coding
problems, and it does not use the original 226-task benchmark's Score.

The workload starts with a shuffled C++ renderer monolith. Agents extract working
modules, then restore specified names using current owners and signatures. They
must preserve the other code, literals, macros and inactive branches. A successful
run restores all 71 goals while keeping the rendered output exactly unchanged.

## What is measured

The primary result is **jointly accepted tasks / total tasks**. Only complete
passing barriers earn progress; a partly completed failed barrier earns none.
There is no individual-agent score. Duration and correction deliveries are
separate measurements, not hidden score weights.

The current dependency graph has width 15. That is the default persistent team
size, not the number actively editing in every round. The default schedule has
28 rounds. Only agents with ready assignments work in a round; others wait.
Ownership rotates between agents. Every assignment and correction tells an agent
how many peers share the project and how many agents are assigned in that round.
A solo run omits that notice and retains the original task order.

The graph follows code dependencies and selector readiness, not task numbering.
Independent monolith extractions can run together even though they edit the same
file. Only the final monolith cleanup waits for all required module moves.

Each agent keeps its own process and conversation. There are no separate answer
worktrees to merge later. Agents see their current assignment and shared source,
not future tasks, private contracts, reference source or expected pixels.

After all assigned agents settle, the verifier checks cumulative editing
obligations, builds a fresh isolated project and renders two scenes twice. All
four outputs must match the pinned pixel hashes. Earlier accepted edits remain
obligations, and source must not change after the barrier.

A failed barrier allows three additional corrections with coarse feedback:
requirements not met, build failed, or images differ. Failed edits and histories
are retained. Nothing resets automatically. Exhausting corrections stops the
jointly accepted prefix. Provider, driver, infrastructure and cancellation stops
are recorded separately from editing blocks.

**There is no default overall or per-attempt time limit.** A live run can continue
indefinitely and spend model credit. Cancel with Ctrl+C or SIGTERM. Agent processes
are closed, and the private evidence is retained. There is no automatic restart.

## Requirements

- Linux x64 or x64 WSL2, Node.js 24 or newer, Python 3 and Bubblewrap.
- Clang 18 available as `clang++`, with the normal C++17 standard library.
- The repository's locked dependencies: `npm ci`.
- For live runs only, an isolated Pi 1.0.1 runtime and explicitly selected model
  credentials. No personal Pi settings or project extensions are loaded.

Run heavy preparation and verification in a Linux environment with enough CPU
and memory. Keep one heavy renderer job at a time under a shared project lock.
Deployment-specific settings belong in your private operator instructions, not
the public recipe.

The bundled fixture has its own [provenance and licenses](../fixtures/explicit-edit-multi-agent/PROVENANCE.md).
Keep generated `notices/` when distributing generated code. The candidate's code
and input attribution are separate from an agent's hidden verification environment.

## Source layout

Both suites live under `src/suites/`: `explicit-edit/` and
`explicit-edit-multi-agent/`. Use `scripts/multi-agent.mjs`, through
`npm run benchmark:multi-agent`, for supported runs. The suite root contains
`prepare.mjs` and `results.mjs`; implementation is grouped by responsibility:

| Directory     | Responsibility                                                         |
| ------------- | ---------------------------------------------------------------------- |
| `generation/` | Pack, rename and shuffle the pinned project; build the input           |
| `tasks/`      | Prepare goals and current selectors; derive dependencies and schedules |
| `execution/`  | Run persistent agents, corrections and cancellation                    |
| `grading/`    | Check cumulative obligations, fresh builds and exact pixels            |
| `reference/`  | Isolated scripted editors and shared compare-and-commit                |
| `cpp/`        | Tokens, structure, compiler AST and binding-aware name helpers         |

Earlier pilot, slice and grouped commands live in
[`scripts/multi-agent/experiments/`](../scripts/multi-agent/experiments/README.md).
They are not alternative candidate entry points. The full and coherent reference
routes still used by clean preparation remain in the working suite. Reference
workers receive only an explicit editing-code allowlist, not these whole directories.

The original suite generates its small input files and expected output in code.
Multi-Agent instead starts from the pinned C++ project in
`fixtures/explicit-edit-multi-agent/`, including its provenance and licenses.
Generated workspaces and run evidence belong in ignored output directories.

## From a clean checkout

All output paths must be new. Preparation and scripted proof use no models, but
perform many compiler and render checks and can take hours. Preparation time is
not a model's benchmark duration.

```sh
npm ci
npm run benchmark:multi-agent -- --help
npm run benchmark:multi-agent -- prepare .tmp/multi-agent-input
npm run benchmark:multi-agent -- verify \
  .tmp/multi-agent-input/preparation .tmp/multi-agent-reference
```

`prepare` generates the named, shuffled monolith from the bundled fixture,
verifies the full restoration route, prepares and proves the coherent goals,
then checks the concurrent graph's routes. `verify` executes the actual shared
parallel schedule, with isolated scripted editors using only public tasks.
A graph check alone is not a parallel execution proof.

If you already have a matching completed coherent preparation and scripted proof,
you may explicitly reuse it instead of regenerating it:

```sh
npm run benchmark:multi-agent -- prepare .tmp/multi-agent-input \
  --from-coherent AUDITED_COHERENT_PREPARATION
```

The preparation still checks source, task and contract identities. It does not
trust a folder name or silently use a local reference answer.

To select a smaller team, use `--agents N` during both verification and the live
run. Values range from one to the graph width. Each exact schedule needs its own
passing scripted proof. For example:

```sh
npm run benchmark:multi-agent -- verify \
  .tmp/multi-agent-input/preparation .tmp/multi-agent-solo-reference --agents 1
```

## Live execution

The candidate currently supports Baseline Agent: pinned Pi 1.0.1, bash only and
an empty system prompt. Other harnesses are not implemented by this entry point.
A provider/model selector is not a harness; OpenCode Go can supply the model while
Pi remains the agent runtime.

Install a separate runtime outside the preparation and candidate workspace:

```sh
mkdir -p .tmp/multi-agent-runtime
npm install --prefix .tmp/multi-agent-runtime --no-save --ignore-scripts \
  @earendil-works/pi-coding-agent@1.0.1
```

Create a private configuration, outside Git. Replace the example paths with
worker-local paths. The model must be available through your selected account:

```json
{
  "runtime": "RUNTIME_INSTALL_DIRECTORY",
  "model": "PROVIDER/MODEL",
  "thinking": "high",
  "authFile": "PRIVATE_SELECTED_PROVIDER_AUTH_JSON"
}
```

Paths are resolved from the working directory. The auth file uses Pi's native
auth format. Supply only the provider needed for the run, not your whole account
collection. Optional `modelsFile` supplies explicit provider definitions;
optional `envFile` is a private JSON map of selected provider environment values.
There is no ambient credential fallback. The runner deletes its copied agent auth
files when closing; it does not delete your original credential files.

The following command spends model credit. The explicit acknowledgement is
required, and the exact team's scripted proof is checked before agents start:

```sh
npm run benchmark:multi-agent -- run \
  .tmp/multi-agent-input/preparation .tmp/multi-agent-live \
  --config PRIVATE_CONFIG_JSON --allow-model-calls
```

Do not add an IDE package to this recipe and call it Baseline Agent. Tooling and
harness comparisons need separately implemented, recorded configurations.

## Export and compare

Raw run directories contain source snapshots, commands, model prose, sessions
and private paths. **Never upload or commit them.** Export only safe facts:

```sh
npm run benchmark:multi-agent -- export \
  .tmp/multi-agent-live .tmp/multi-agent-result.json
npm run benchmark:multi-agent -- validate .tmp/multi-agent-result.json
```

Export and validation are offline. They do not compile, authenticate, call models
or upload anything. Export requires a finished run and creates a new file without
modifying raw evidence. It checks schedule identity, accepted barriers, deliveries
and correction exhaustion. Unknown usage and cost remain null. Cost, when present,
comes from runtime price metadata, not a provider billing receipt.

The [result format](multi-agent-results.md) keeps this benchmark separate from
old Exact Edit results. Compare runs with the same protocol, workload, schedule,
team and harness/runtime. The compatibility key deliberately excludes model and
reasoning, which are the variables being compared. Passing local validation does
not authenticate a submitted run; public acceptance is a later integration step.

Old experimental reports lack the candidate's explicit protocol metadata. They
cannot be silently relabelled by the exporter. Their reviewed observations are
retained in the [calibration notes](multi-agent-calibration.md).

## Status

This is a runnable candidate, not yet a Dataset submission format or Explorer
track. No command here publishes automatically. The old benchmark's commands,
Score, Dataset and accepted observations remain unchanged.

Implementation detail and the scripted editor's compare-and-commit technique are
in [Rotating concurrent editing](renderer-concurrent.md).
Live agents are not required to use the reference editor's locking technique.
