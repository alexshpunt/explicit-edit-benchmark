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

The accepted-prefix protocol below remains the interpretation of existing observations.
The round-score protocol is a separate methodology; it never changes historical scores.

### Accepted-prefix protocol

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

### Round-score protocol

`shared-project-restoring-v2` uses the separate native Baseline entry points below.
They require a new proof from the exact committed source and run policy. The common
run and submission commands remain accepted-prefix commands; they do not select
restoration implicitly.

The grading core supports naming and structural endpoints, including final
physical destinations, old-copy absence, declaration counts and explicit empty
namespace cleanup. Trusted provenance follows later moves and inline conversion.
Context-only changes do not grant permission to damage unchanged bodies. Required
standard imports are checked for each selected consumer, including inactive code.
Build and repeated-image outcomes are measured independently. Persistent Pi
participants expose an idle-state check that does not request inference; a dead
participant cannot silently restart.

The workload remains all 71 tasks and their 11,178 original atomic edits. The
configured team size is a maximum, not a required number of occupied agents.
Ready dependencies determine assignments, and different maxima may produce
schedules with different numbers of rounds. Idle participants create neither
failed edits nor additional denominator entries.

A round is measured only after all assignment queues, native turns and writes
have drained. Each original atom receives binary credit from that final shared
source. Repairs never become new original atoms. Independent correct bindings
can receive credit when a sibling edit is incomplete, including when both edits
share a declaration. Required declaration/use bindings, physical ownership,
protected code, macros and inactive branches remain obligations. Build success
alone cannot establish edit credit.

A destructive edit invalidates the atoms whose required source or bindings it
breaks. Corruption of protected code outside those attributable footprints is a
separate integrity violation: **the entire round scores zero**, even if all
requested names, the build and rendered images otherwise pass. The report keeps
raw atom outcomes alongside this veto.

For round `r`, let `q[r]` be successful original atoms divided by assigned original
atoms. Let `wBuild` and `wResult` be finite weights at least 1, defaulting to 2 and 4:

- `buildFactor[r]` is 1 after a successful fresh build, otherwise `1 / wBuild`.
- `resultFactor[r]` is 1 when that build and all repeated scene comparisons pass,
  otherwise `1 / wResult`.
- `integrity[r]` is 1 when preservation passes, otherwise 0.

With `R` equal to the full planned number of rounds:

```text
Score = (100 / R) * sum(q[r] * buildFactor[r] * resultFactor[r] * integrity[r])
```

Every round has the same maximum contribution, irrespective of its atom count.
Unobserved rounds contribute zero; an interrupted run is not averaged over only
its completed rounds. Build and result failures reduce credit rather than
multiplying it by zero. The verifier attempts their evidence collection even
when some structural edits fail. Outputs cannot pass without a successful build.

The first attempt and up to five corrections share one candidate and persistent
histories. The final attempt determines the primary round score; first-attempt
and final evidence are both retained. After recording the measured candidate,
the controller restores the exact trusted **end of that round**, on success as
well as failure. Restoration removes extra files and repairs missing or damaged
ones. It grants no credit and never exposes later rounds' source.

The same participant processes, mounted workspace and separate histories survive
restoration. All participants are informed before their next assignments, and
queue rotation continues. No model call or write may overlap restoration. A
failed restore is an infrastructure stop, not an editing outcome. Ordinary edit
failure after six attempts does not prevent the next round. Provider, auth,
runtime, cancellation and infrastructure stops remain distinct.

Canonical restoration is not the accepted-prefix diagnostic recovery mechanism:
it does not open fresh sessions, reset attempts or retroactively accept a failed
candidate. Historical observations and reference proofs retain their original
protocol and source identities. The original 226-task suite is unchanged.

### Native restoring entry points

Use the installed, approved Pi 1.3.0 runtime. Baseline keeps one actual process per
participant, with Bash only and an empty system prompt. A fresh process with a
continued session is not a persistent participant. Idle checks request no
inference and reject live tool descendants before measurement or restoration.
A detached background writer is a runtime/infrastructure violation, not another
editing attempt.

The integration fixture in `test/renderer/restoring.test.mjs` uses real persistent
Pi processes with a local scripted provider. It covers six editing failures,
current-round restoration and later edits, plus process death, cancellation,
a detached writer, restoration failure and workspace loss. A wording-only source
variant must pass with its own proof; neither fixture proof replaces the required
full-workload reference proof.

Reuse an audited full preparation. Generate a separate, model-free proof with the
same maximum occupancy, batch size and weights as the intended observation:

```sh
node scripts/multi-agent.mjs verify-restoring PRIVATE_PREPARATION \
  .tmp/restoring-proof --agents 2 --batch-size 1 \
  --build-weight 2 --result-weight 4
```

Maximum occupancy 2 yields 38 planned rounds for the full workload. Every planned
round must pass its first reference check. A failed reference candidate is
preserved without restoration, then verification stops as ineligible. Reference
verification cannot use five corrections to manufacture a passing proof.

An authorizing proof requires clean, committed source. It binds the exact commit,
verifier, execution code, dependency lockfile, immutable workload and graph,
every original atom and canonical endpoint, schedule and grading policy.
Historical preparation proofs do not authorize this protocol. A changed commit,
dirty source, different batch or changed weight requires a new matching proof.
Dirty source is rejected before reference execution begins.

Keep native configuration private and outside the shared candidate. Use absolute
paths for the approved runtime root and existing credential files:

```json
{
  "runtime": "ABSOLUTE_APPROVED_PI_RUNTIME_ROOT",
  "model": "PROVIDER/MODEL",
  "thinking": "high",
  "authFile": "ABSOLUTE_PRIVATE_AUTH_FILE"
}
```

`runtime` names the root containing `node_modules`, not the CLI executable.
`modelsFile` can name an existing private model registry for the same route.
`envFile` accepts only explicit provider-credential environment keys. This native
configuration is distinct from the common harness-adapter configuration. Do not
silently discard adapter arguments or provider environment when converting it.
Use approved access-only credentials when refresh is not authorized. Stop on missing or expired
access rather than logging in, refreshing credentials or switching accounts during preparation.

Only after the proof and free gates match, and model calls are authorized:

```sh
node scripts/multi-agent.mjs run-restoring PRIVATE_PREPARATION \
  .tmp/restoring-observation --agents 2 --batch-size 1 \
  --build-weight 2 --result-weight 4 \
  --config PRIVATE_NATIVE_CONFIG.json \
  --proof .tmp/restoring-proof/verification.json --allow-model-calls
```

Both commands keep private raw evidence in fresh output directories. Every
candidate is captured before interpretation, including malformed bytes,
non-UTF-8 names and symlinks. Lexical byte views never replace compiler input.
Successful original translation units can certify independent atoms when another
TU fails. A special entry that cannot be mirrored prevents original compiler
certification and is recorded explicitly. Missing compiler evidence alone does
not prove collateral protected-source corruption.

First and final attempt evidence remain separate. Only a completed canonical
restoration adds an observed round; an interrupted, unrestored round contributes
zero in the full planned denominator. Failed editing rounds can coexist with a
complete run and a score below 100. Source changes after a drained boundary,
failed shutdown or source-code drift make the run operationally ineligible.

`export RUN_DIRECTORY NEW_RESULT_JSON` produces a safe local result, and
`validate RESULT_JSON` rechecks its evidence-derived score. Neither command
publishes or submits it. Restoring results have a separate result version and
comparison identity. Official publication requires separately reviewed release
evidence; a historical release approval is insufficient.

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

These common commands retain the historical `shared-project-rotating-v1` protocol.
Use the native restoring entry points above for `shared-project-restoring-v2`.
An explicit restoring selection cannot fall through to the historical runner.

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
