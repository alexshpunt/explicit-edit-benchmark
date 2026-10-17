# Explicit Edit — Multi-Agent

Multi-Agent measures reliable editing of one large existing project by agents
working concurrently in a shared workspace. It uses the common benchmark CLI,
harness adapters, normalized statistics and submission store. Its tasks and
ranking stay separate from the original 226-task suite.

The input is a shuffled C++ renderer monolith. Agents extract working modules,
then restore names using current owners and signatures. They must preserve the
other code, literals, macros and inactive branches. All 71 goals must leave the
rendered output unchanged.

## Run policy and Score

A scored run always uses **15 persistent agents and all 71 scoring groups**, with
28 full verification barriers. Each free participant receives one ready atomic
request. A rename targets one compiler-certified binding and its bound uses, not
just one textual mapping. A structural request moves one definition or a genuinely
inseparable unit with its required cleanup.

The atomic graph follows code dependencies and selector readiness, not task
numbering. Independent edits can run together in the same file. Only a passed
lightweight structural check unlocks successors; a settled agent response does
not. The controller rechecks prerequisites against the current source before
dispatch. An unstable observation while peers write stays pending rather than
becoming a completed edit or an automatic editing failure.

Assignments rotate among free participants. A busy participant never receives a
second active delivery, and unrelated ready work need not wait for it. Agents
share the writable project but keep separate state and histories. They see only
the current request, not future tasks, private binding plans, contracts, reference
source or expected pixels. Existing harness adapters own native continuation;
the benchmark does not replace a selected harness with Baseline Agent.

Lightweight checks verify individual edits between deliveries. At each of the
28 full barriers, the runner drains active writers, checks cumulative obligations,
builds a fresh isolated project and renders two scenes twice. All four outputs
must match the pinned pixels. Only this full check grants joint credit to the
barrier's original scoring groups. Atomic passes do not earn separate Score credit.
Earlier accepted edits remain obligations, and source must not change after grading.

A failed barrier allows **five corrections after the initial attempt**, for six
attempts in total. Feedback stays coarse: requirements not met, build failed, or
images differ. Corrections retain source, participant histories and valid completed
edits; regressed prerequisites and their dependents lose completion. When all
atomic outputs remain verified but full grading fails, one free participant gets
a separate global barrier-repair delivery. It uses the same correction budget,
not a hidden per-edit retry. Exhaustion stops the accepted prefix. Provider,
driver, infrastructure and cancellation stops are recorded separately.

**Score = 75% first-pass success + 25% eventual success**, weighted by the same
71 scoring groups. First-pass means the group's full barrier passed on its initial
attempt; eventual means it passed within the six-attempt budget. A partly completed
failed barrier earns no task credit. There is no individual-agent score. Duration,
cost and delivery counts are not Score weights. Rankings remain separate from the
original suite.

**Local team runs have no overall or delivery deadline.** They can continue
indefinitely and spend model credit. Cancel with Ctrl+C or SIGTERM. Owned agent
processes close and private evidence remains. Official GitHub-hosted jobs are
subject to GitHub's six-hour platform limit, not a benchmark task deadline.

## Requirements

- Linux x64 or x64 WSL2, Node.js 24 or newer, Python 3 and Bubblewrap.
- Clang 18 available as `clang++`, Clangd and the normal C++17 standard library.
- Locked repository dependencies: `npm ci`.
- For model runs, the selected agent CLI, model access and explicit credentials,
  using the same configuration rules as the original suite.

Use enough CPU and memory for preparation and fresh builds. Keep one heavy
renderer job at a time under a shared project lock. Machine-specific settings
belong in private operator instructions, not this guide.

The bundled fixture has its own [provenance and licenses](../fixtures/explicit-edit-multi-agent/PROVENANCE.md).
Keep generated `notices/` when distributing generated code.

## Common run and submission

The following command **calls a model and submits the result**. Confirm that
both actions are intended before running it:

```sh
npm run benchmark -- run --local --suite explicit-edit-multi-agent \
  --harness pi-default --model PROVIDER/MODEL --thinking high
```

Choose any existing ready adapter listed in the root README. A custom harness
or model-harness matrix uses the existing configuration API:

```sh
npm run benchmark -- run --local --suite explicit-edit-multi-agent \
  --config PRIVATE_BENCHMARK_CONFIG
```

The common flow checks the adapter, performs a one-task model/auth smoke check,
prepares the workload and requires a matching full 15-agent atomic scripted proof
before starting the measured team. A smoke check or partial certification is not
that proof. Teams for different configurations run sequentially; each measured
team has its own project and participant state.

There is no scored `--task`, smaller team, fresh retry or finite timeout option
for this suite. `--concurrency 15` is accepted but is already the default.

For runs without automatic submission, use the common `raw-run`, `export` and
`inspect` commands described in [development commands](running.md#development-commands).
`raw-run` accepts `--suite explicit-edit-multi-agent` and an explicit
`--preparation PREPARATION` with a matching completed 15-agent proof. It still
requires the same model/auth smoke readiness; preparation is not a substitute.

## Model-free preparation and proof

Preparation performs many compiler and render checks and can take hours. It
uses no models. Preparation time is not a model's benchmark duration. All output
paths must be new:

```sh
npm ci
npm run benchmark:multi-agent -- prepare .tmp/multi-agent-input
npm run benchmark:multi-agent -- verify \
  .tmp/multi-agent-input/preparation .tmp/multi-agent-reference
```

These are developer/reference commands, not a second model-result protocol.
`prepare` generates the named, shuffled monolith, verifies the restoration route
and coherent goals, then seals certified atomic requests, private binding batches
and their graph. `verify` executes the actual atomic stream through the same
scheduler and gates, with isolated scripted editors receiving current public
requests only. Measured execution requires a completed proof for the current
workload, atomic inventory, dispatch policy and exact participant count. Old coarse
delivery proofs, graph checks and partial certification are not substitutes.

An explicitly selected coherent preparation can be reused only when its current
certified binding records, hashes and completed coherent proof match:

```sh
npm run benchmark:multi-agent -- prepare .tmp/multi-agent-input \
  --from-coherent AUDITED_COHERENT_PREPARATION
```

Smaller scripted teams remain available for development. They are not scored
observations and cannot enter the common 15-agent result protocol.

## Results and privacy

Raw run directories contain source, commands, prose, sessions and private paths.
**Never upload or commit them.** Use the same safe bundle as the original suite:

```sh
npm run benchmark -- export results/RUN_ID
npm run benchmark -- inspect results/RUN_ID/normalized
```

Schema 3 links atomic deliveries, participants and full grading barriers in the
common five tables. Tool calls, model rounds, errors, usage and cost come from the
selected harness's native events. Missing facts stay null. Native evidence is
counted once per actual delivery, including global barrier repair. Retaining a
completed edit does not fabricate another delivery. Team time is wall-clock time,
not summed parallel process time. See the [result contract](multi-agent-results.md).

A valid local bundle is not authenticated evidence. Ordinary submissions use
the existing unverified contribution path. Official submissions use the existing
signed archive and attestation path, with an explicitly approved suite registry.

## Official release gate

The producer and validator support suite selection, but the currently deployed
policy and external caller template do not yet authorize this suite. Maintainers
must approve canonical workload, graph, schedule, fixture and verifier identities,
plus atomic workload and private-batch hashes, dispatch policy and complete atomic
inventory. This requires a fresh reviewed model-free proof of all 71 groups and
28 barriers through the atomic stream. They must then release the pinned workflow
and update the caller's suite input before official Multi-Agent runs can be used.
The gate remains closed without that proof and activation. Old coarse or
experimental evidence must not be relabelled as atomic authorization. Nothing in
this guide performs that release or publishes a reference proof as a model
observation.

## Source layout

Both suites live under `src/suites/`. Multi-Agent keeps orchestration and result
identity at its root, with these clusters:

| Directory     | Responsibility                                          |
| ------------- | ------------------------------------------------------- |
| `generation/` | Pack, rename and shuffle the pinned input               |
| `tasks/`      | Goals, current selectors, dependencies and schedules    |
| `execution/`  | Participants, corrections and cancellation              |
| `grading/`    | Atomic gates, cumulative obligations, builds and pixels |
| `reference/`  | Isolated scripted editors and compare-and-commit        |
| `cpp/`        | Tokens, structure, compiler AST and binding helpers     |

Input files are in `fixtures/explicit-edit-multi-agent/`. The original suite
instead generates its small inputs and expected output in code. Older pilot,
slice and grouped commands live in [the experimental scripts](../scripts/multi-agent/experiments/README.md).
The full and coherent reference routes remain preparation dependencies. Workers
receive an explicit editing-code allowlist, never the whole trusted suite.

[Calibration observations](multi-agent-calibration.md) are historical evidence,
not relabelled common-protocol submissions. The reference editor's locking
technique is described in [rotating concurrent editing](renderer-concurrent.md);
measured agents are not required to use that technique.
