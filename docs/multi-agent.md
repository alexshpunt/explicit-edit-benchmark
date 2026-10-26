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

A scored run always uses **15 agents and all 71 tasks**. The dependency graph has
width 15 and fixes a schedule of 28 barriers. At each barrier its atomic edits are
split as evenly as their dependencies permit across the team. A dependency chain
stays with one agent, in dependency order. All agents receive work when the
barrier has enough independent edits; a smaller barrier uses fewer agents. The
28 barriers are not merged to fill the team.

Each agent receives a queue of messages. The configurable delivery size defaults
to 50 atoms per message; this is an experimental value, not a required workload
size. An agent receives its next message when the harness returns control at the
end of its turn. The controller does not read the reply text or treat a turn end
as proof that edits succeeded. Every assignment and correction discloses the total
team size and the number currently assigned.

The graph follows code dependencies and selector readiness, not task numbering.
Independent monolith extractions can run together even when they edit the same
file. Final monolith cleanup waits for the required module moves.

Agents share the writable project, but have separate state and histories. They
see the current assignment, not future tasks, private contracts, reference source
or expected pixels. Existing harness adapters own their native continuation.
The benchmark does not replace a selected harness with Baseline Agent.

Verification starts only after every agent has exhausted its queue and returned
control. No input or output gate checks individual atoms or intermediate source.
At the barrier, the verifier compares the candidate with the trusted expected
snapshot through a per-file symbol map. Clang 18's libclang supplies declaration
USRs and referenced symbol USRs; declaration and body tokens preserve exact names
and code. File-internal declaration order and reopened namespaces are allowed.
Macros, inactive preprocessor branches and locals retain lexical protection.
Earlier accepted edits remain obligations.

A fresh isolated build and two scenes rendered twice must also pass. All four
outputs must match the pinned pixels, and source must not change after the
barrier. A passing build or an agent's claim of completion alone earns no credit.

The scripted reference must pass every barrier on its first check, with no
correction deliveries. A failed reference check stops the proof. Its participants
plan in parallel and apply file patches atomically using ordinary Bash-accessible
filesystem primitives. This is their editing strategy; the benchmark does not
force measured agents through a shared editor or protect arbitrary writes.

For measured agents, a failed barrier allows five corrections, for six attempts in total. Corrections
are grouped by file and split as evenly as possible across the whole team. One
file goes to one agent; the controller does not use the original executor.
Feedback follows this priority:

1. Symbol-map or protected-source mismatches produce fresh current problems:
   wrong declaration names, wrong physical owners, missing module setup or
   unresolved compiler uses. The planner uses actual candidate compiler facts
   and requirements already public through this barrier. Satisfied work is not
   reassigned, and historical atom prompts are never replayed. Remaining
   non-mechanical source problems receive an inspection item.
2. When the map is clean, compiler errors are grouped by file.
3. When the map and build pass, a pixel mismatch produces one general
   "rendered images differ" item.

Agents never receive private contract tokens, USRs, reference source or expected
pixels. Failed edits and histories remain, with no reset or fresh retry.
Exhausting corrections stops the accepted prefix. Provider, driver,
infrastructure and cancellation stops are recorded separately.

**Score is jointly accepted tasks / 71.** A partly completed failed barrier earns
no task credit. There is no individual-agent score. Duration, cost and correction
counts do not weight Score. The original suite keeps its existing Score.

**Local team runs have no overall or delivery deadline.** They can continue
indefinitely and spend model credit. Cancel with Ctrl+C or SIGTERM. Owned agent
processes close and private evidence remains. Official GitHub-hosted jobs are
subject to GitHub's six-hour platform limit, not a benchmark task deadline.

## Requirements

- Linux x64 or x64 WSL2, Node.js 24 or newer, Python 3 and Bubblewrap.
- Clang 18 available as `clang++`, Clangd, libclang 18 with its official Python
  bindings (`python3-clang-18` on Ubuntu), and the normal C++17 standard library.
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
prepares the workload and requires a matching 15-agent scripted proof before
starting the measured team. Teams for different configurations run sequentially;
each measured team has its own project and participant state.

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

`verify` and `run` accept `--batch-size N`. A live team must use the same delivery
size as its scripted proof; a different size requires a new proof.

These are developer/reference commands, not a second model-result protocol.
`prepare` generates the named, shuffled monolith, proves the full restoration
route and coherent goals, then checks the concurrent graph. `verify` executes
the real parallel schedule with isolated scripted editors using public tasks.
A graph check alone is not a parallel execution proof.

An explicitly selected, matching coherent preparation can be reused:

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

Schema 3 adds task/barrier/participant links to the common five tables. Tool
calls, model rounds, errors, usage and cost come from the selected harness's
native events. Missing facts stay null. Every delivery is counted once, even
when its assignment contains several tasks. Team time is wall-clock time, not
summed parallel process time. See the [result contract](multi-agent-results.md).

A valid local bundle is not authenticated evidence. Ordinary submissions use
the existing unverified contribution path. Official submissions use the existing
signed archive and attestation path, with an explicitly approved suite registry.

## Official release gate

The producer and validator support suite selection, but the currently deployed
policy and external caller template do not yet authorize this suite. Maintainers
must approve canonical workload, graph, schedule, fixture and verifier identities,
release the pinned workflow and update the caller's suite input before official
Multi-Agent runs can be used. Unapproved runs must stop before model calls; old
release pins do not silently authorize a new benchmark. Nothing in this guide
performs that release or publishes a reference proof as a model observation.

## Source layout

Both suites live under `src/suites/`. Multi-Agent keeps orchestration and result
identity at its root, with these clusters:

| Directory     | Responsibility                                        |
| ------------- | ----------------------------------------------------- |
| `generation/` | Pack, rename and shuffle the pinned input             |
| `tasks/`      | Goals, current selectors, dependencies and schedules  |
| `execution/`  | Participants, corrections and cancellation            |
| `grading/`    | Cumulative obligations, fresh builds and exact pixels |
| `reference/`  | Independent scripted editors and ordinary file edits  |
| `cpp/`        | Tokens, structure, compiler AST and binding helpers   |

Input files are in `fixtures/explicit-edit-multi-agent/`. The original suite
instead generates its small inputs and expected output in code. Older pilot,
slice and grouped commands live in [the experimental scripts](../scripts/multi-agent/experiments/README.md).
The full and coherent reference routes remain preparation dependencies. Workers
receive an explicit editing-code allowlist, never the whole trusted suite.

[Calibration observations](multi-agent-calibration.md) are historical evidence,
not relabelled common-protocol submissions. The independent reference editors
and their shared-file behavior are described in
[rotating concurrent editing](renderer-concurrent.md).
