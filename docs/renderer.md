# Renderer implementation and restoration routes

Start with the [Multi-Agent run guide](multi-agent.md) for the current benchmark
candidate. This technical guide covers its shared renderer generator and the
earlier restoration experiments. Shared implementation lives in the responsibility clusters under
`src/suites/explicit-edit-multi-agent/`; older commands and their exclusive helpers
live in `scripts/multi-agent/experiments/`,
and the pinned Yocto/GL input and licenses live in `fixtures/explicit-edit-multi-agent/`.
The generator removes comments, packs every required project/vendor source into one C++ file,
and optionally gives supported bindings varied names and disperses whole functions.
It preserves behavior. The eleven-request pilot has a generator, candidate grader,
isolated scripted runner and live Baseline Agent. It is still a partial restoration
route, not the full restoration benchmark.

The complete coherent workload also has a [rotating concurrent runner](renderer-concurrent.md).
It derives safe task dependencies before choosing a team size. All persistent
agents edit the same evolving source tree; a team of one keeps the old task route.

## Run the eleven-request pilot

Use `pilot.mjs` as the experimental entry point. It is separate from V1 selection,
scores and export. It prepares its inputs from the pinned fixture, not old scratch
artifacts. Run in a suitable Linux environment with the dependencies below.
Keep one heavy job at a time under a shared project lock. For a single checkout,
the examples use `.tmp/renderer-check.lock`; share one lock across checkouts.

From a fresh checkout with its locked dependencies installed:

```sh
mkdir -p .tmp
flock -n .tmp/renderer-check.lock node scripts/multi-agent/experiments/pilot.mjs ready
flock -n .tmp/renderer-check.lock node scripts/multi-agent/experiments/pilot.mjs prepare .tmp/pilot-prepared
flock -n .tmp/renderer-check.lock node scripts/multi-agent/experiments/pilot.mjs ready .tmp/pilot-prepared
flock -n .tmp/renderer-check.lock node scripts/multi-agent/experiments/pilot.mjs verify .tmp/pilot-prepared .tmp/pilot-offline
node scripts/multi-agent/experiments/pilot.mjs report .tmp/pilot-offline
```

These modes never start a model. Preparation takes several minutes. It checks
Linux x64, Node.js 24 or newer, Clang/Clangd 18 and actual Bubblewrap isolation.
It then verifies all generation/inverse checkpoints and all twelve slice reference
states with fresh builds and two repeated scenes. There is no unsandboxed fallback.

`pilot.json` is written only after preparation passes. It identifies the fixture,
implementation, grader, initial source, workload and trial policy with hashes.
Readiness rejects changed code, fixture, workload or policy; prepare again after a
code change. It probes dependencies and checks identities, but does not replace
build/render verification or authenticate with a provider.

The preparation contains:

- `slice/workspace/main.cpp`: the only initial agent source.
- `slice/review.md`: all eleven requests for human review.
- `slice/trusted/states/initial/build/scene-0.ppm` and `scene-1.ppm`: reference
  pictures. Each later state has its own fresh pictures and exact float pixels.
- `slice/trusted/` and `generation/`: private reference and generation evidence.
  Never mount them into an agent.
- `generation/notices/`: attribution, outside the agent workspace.

Verification copies the initial source into one new trial workspace and uses the
existing isolated scripted executor and trusted grader. No inverse or source
snapshot advances the executor. Trials keep their pilot identity in `report.json`
alongside the durable attempt history and before/after source evidence.
Existing outputs are never overwritten. A failed candidate gets at most three
attempts for its current request; later requests are withheld after a terminal stop.

To check another ordinary scripted executor, pass a private JSON file as the last
argument to `verify`:

```json
{ "harness": "scripted", "executor": "PATH_TO_EXECUTOR_DIRECTORY" }
```

Only its regular `reference/scripted-worker.mjs` and `cpp/cpp-tokens.mjs` files are copied into the
isolated executor. The worker reads the current request from stdin and edits
`/workspace`. No other files from the configured directory are mounted.
This is a scripted proof, not a model observation.

### Explicit live execution

Live execution requires separate user approval. Readiness does not grant it.
Use a private configuration with `"harness": "baseline-agent"` plus the runtime,
model, thinking and explicit credential fields described in the live section.
The pilot accepts only the separately installed Pi 1.0.1 runtime. Configuration
paths are relative to that configuration file, unlike the older lower-level CLI.

```sh
flock -n .tmp/renderer-check.lock node scripts/multi-agent/experiments/pilot.mjs ready .tmp/pilot-prepared --live PRIVATE_CONFIG_JSON
# Only after separate approval:
flock -n .tmp/renderer-check.lock node scripts/multi-agent/experiments/pilot.mjs live .tmp/pilot-prepared .tmp/pilot-live PRIVATE_CONFIG_JSON --allow-model-calls
```

Unknown harnesses, missing prerequisites and missing live authorization fail
before starting an agent. Readiness never calls the provider. It cannot prove
account entitlement or provider availability; those failures remain distinct
terminal outcomes during a separately approved live run.

The live policy remains one real Pi conversation/process, bash only, an empty
system prompt, at most three attempts per request, ten minutes per attempt and
two hours for the chain. Scripted worker calls also have a thirty-second process
timeout. Credentials and ambient personal Pi configuration are not inherited.
Raw trial reports, timelines, source evidence, traces and private configurations
must not be committed or published. Only the allowlisted summaries are safe
progress views, not V1 scores.

After cancellation or a process crash, preserve the trial and run `report` to
rebuild its views offline. This does not resume an interrupted agent or fabricate
missing observations. A new run needs a new output directory.

### Check the assembled commands without a model

The dedicated scenario suite starts from the fixture in a fresh directory. It
checks eleven-step completion, a retained compiler failure and repair, a
three-attempt block, cancellation, crash cleanup and offline report recovery:

```sh
RENDERER_PILOT_OUTPUT=.tmp/pilot-command-proof \
  flock -n .tmp/renderer-check.lock node --test test/renderer/pilot.test.mjs
```

The real-Pi no-cost provider proof can use the same preparation with
`RENDERER_PILOT_PREPARATION` in the live-slice test below. It executes the public
`ready` and `live` commands; it is not a paid model score.

## Generate and verify

From the repository root, with Node.js 24 and Clang 18 on Linux x64:

```sh
node src/suites/explicit-edit-multi-agent/generation/run.mjs generate .tmp/renderer-bundle
node src/suites/explicit-edit-multi-agent/generation/run.mjs generate-names .tmp/renderer-varied
```

Each output directory must be new. There are no model calls. Verification takes
several minutes: every forward/inverse state builds fresh and renders two scenes
twice. The original commented fixture is also built to check comment removal.

Both commands first prepare a comment-free canonical project. Vendor originals
stay unchanged in `fixtures/explicit-edit-multi-agent/`. License notices and provenance go into `notices/`,
not the agent payload. Removal drops comment-only lines entirely and keeps only
required inline separators and directive endings. `stripComments` also trims blank
file edges, including outer spaces, and keeps at most one internal blank code line.
It retains a required terminating newline after a trailing continuation backslash.
It protects literals and handles C++ line splicing and preprocessor token boundaries.
It is preparation,
not a reversible operation: inversion does not recover removed comments.

Output:

- `forward/00/source`: the comment-free canonical project.
- `forward/20/source/main.cpp`: packing-only monolith after blank-line trimming.
- `forward/22/source/main.cpp`: varied names before mixing.
- `forward/23/source/main.cpp`: added function declarations.
- `forward/24/source/main.cpp`: mixed whole definitions; placement report coordinates refer here.
- `forward/25/source/main.cpp`: varied and mixed monolith with neutral origin identifiers.
- `forward/26/source/main.cpp`: final monolith after blank-line trimming.
- `payload/main.cpp`: the only file to give the agent as initial project code.
- `reverse/`: the computed inverse checkpoints.
- `build/` at each verified checkpoint: fresh executable, PPM previews and raw
  RGBA float pixels. Exact comparison uses floats, not rounded previews.
- `operations.json`: guarded forward/inverse records, without source snapshots.
- `report.json`: compiler settings, source identities, naming diversity and checks.
- `notices/`: required attribution kept with the experiment, outside the agent's
  workspace. Keep these notices when distributing generated code.

Packing has 19 merge/include operations followed by blank-line trimming: 20
operations and 42 checkpoints. Naming adds three operations before trimming:
functions/types, fields, then variables/parameters. Named generation also adds
forward declarations and mixes whole definitions. Origin masking adds one more operation. These are 26 operations and
54 checkpoints, not 26 agent requests. A separate final check builds
only `payload/main.cpp` in an empty project directory, without extra translation
units, project includes or prebuilt project libraries. Compiler and standard-library
headers are the declared environment, not hidden project dependencies.

Failures stop generation. Unverified API generation reports `unverified`, not
`pass`. Source identities and records contain no absolute paths or timestamps.
Generated evidence belongs in ignored scratch storage, not tracked source files.

## Unpack

```sh
node src/suites/explicit-edit-multi-agent/generation/run.mjs unpack \
  .tmp/renderer-varied/payload \
  .tmp/renderer-varied/operations.json \
  .tmp/renderer-restored
```

This uses only the monolith and serialized records to restore the canonical
comment-free project byte for byte. It checks identities but does not rerun builds.
A modified bundle is rejected, never replaced with saved clean code. This is a
reference inverse, not a grader for arbitrary agent solutions.

## Restore structure first, then names

```sh
node src/suites/explicit-edit-multi-agent/generation/run.mjs restore \
  .tmp/renderer-varied/payload \
  .tmp/renderer-varied/operations.json \
  .tmp/renderer-reference
```

Unlike `unpack`, this command verifies a new reference route. It first restores
function placement and removes generated prototypes. It extracts the original
headers and implementation files while keeping the varied binding names and neutral
namespace/guards. Only after all files are back does it restore variables/parameters,
fields, functions/types and translation-unit helpers. The neutral project identity
stays in file paths, includes, namespace and guards through the final state.

The command uses only the supplied monolith and guarded records. It does not load
clean fixture sources or read old checkpoint folders. Physical token origins carry
each binding's naming through extraction; unrelated same-spelling variables keep
their own assignments. Repeated macro-controlled header copies merge their active
rename coverage. Conflicting assignments are rejected, not guessed.

Every checkpoint has a fresh build and renders both scenes twice. Pixels must
match the starting monolith exactly. `report.json` records phase, action, source
identity and verification status. `restored/` contains the final comment-free project,
with neutral paths/includes, original declaration/definition placement and restored
working names. It never restores the source project's brand. Failed
verification stops the route and records a failure. Existing outputs are never
overwritten. Attribution remains in the generation's separate `notices/` directory.

This is a deterministic reference route, not the agent workload or its grader.
Its current generator-level transitions can contain many edits. Agent requests will
split these into small working changes; their count is not fixed at 20. Acceptance
for agents concerns original structure, names and rendering, not comments,
formatting or byte equality. The reference implementation happens to restore exact
canonical bytes after the same deterministic identity mapping as an additional check.
The private `unpack` diagnostic still checks the exact historical inverse; its
unmasked output is not a benchmark endpoint and must not be given to an agent.

## First atomic request slice

This experiment adds a small request chain, not the full restoration workload:

```sh
node scripts/multi-agent/experiments/slice-run.mjs generate \
  .tmp/renderer-varied/payload \
  .tmp/renderer-varied/operations.json \
  .tmp/renderer-atomic
node scripts/multi-agent/experiments/slice-run.mjs request .tmp/renderer-atomic step-01
```

It starts with the unchanged mixed monolith. There is no pre-split seed. Its eleven
requests first extract the common math header, then two public void declarations
and their definitions into neutral shape module paths (for example, `frond_shape.h`
and `frond_shape.cpp`, with `frond_math.h` for math). They then restore the
parameters and locals of each void overload, the `vec4f` field, two whole function
name families (`make_rect` and `make_recty`), and the `vec4f` type name. Related code
is revisited in the same source tree. Other modules, names and mixed definitions
stay unchanged. This partial endpoint is not the full original project.

A header transfer is one structural request; its source is not pasted into the
prompt. Naming requests group one function's variables or one type's fields.
Every request has a short target description, depends on the preceding request,
and inherits earlier obligations. Name changes explicitly replace the old name
obligations without dropping file ownership. Redundant generated prototypes in
`main.cpp` remain until the wider restoration route removes them.

Output separates the two audiences:

- `workspace/`: only the original monolith, ready for an agent.
- `review.md`: the whole request chain for human review, not agent input.
- `trusted/workload.json`: requests and cumulative obligations.
- `trusted/states/`: reference source, fresh builds and image previews at every step.
- `trusted/report.json`: source identities and verification results.

Keep `trusted/` and `review.md` outside the agent's mounts. The `request` command
prints only the selected request, not future instructions or reference answers.
This command does not run an agent or enforce delivery order. Use the pilot entry point
above for sequential delivery. Request inspection makes no model calls.

The reference uses compiler-selected whole declarations and definitions. Variable
renames stay within the selected void overload, including its redeclarations;
other overload locals stay unchanged. Global name restoration requires a recorded
family with a unique generated spelling across all supported assignments. Literals
are never replaced. Ambiguous families or altered payloads are rejected.

The slice checks cumulative ownership and names, builds every state fresh, and
renders both pinned scenes twice against the starting monolith. These checks prove
this reference path for this fixture and environment, not every possible C++ input
or arbitrary candidate solution. The independent scripted walkthrough below also accepts a byte-different solution.
The full restoration workload remains separate work. The candidate grader and live
runner below support this pinned eleven-request slice.

## Independent scripted walkthrough

After preparing the slice, run its eleven requests without generator answers:

```sh
node scripts/multi-agent/experiments/scripted-run.mjs \
  .tmp/renderer-atomic/workspace \
  .tmp/renderer-atomic/trusted/workload.json \
  .tmp/renderer-scripted
```

The output must be new. The supervisor copies the initial monolith once, then sends
one current prompt to a Bubblewrap worker. The worker sees only its own code, a
pure C++ token lexer, the current project and the current prompt. It cannot read
generator records, reference states, future requests or host credentials.
The runtime is read-only, the project is writable, and network access is isolated.
There is no unsandboxed fallback.

The worker edits current source using ordinary JavaScript scripts. It finds guarded
header boundaries, transfers complete void declarations and definitions, then
renames the selected identifiers while protecting literals and other overload locals.
It never loads old source or calls a generator inverse. This is a pinned happy-path
solver for these prompts, not a general English interpreter or C++ refactoring tool.
The selected global family/type/field spellings must be unique in this slice.

Before the first request and after every edit, the supervisor checks cumulative
obligations, compiles fresh, renders both scenes twice and compares exact pixels.
It stops on the first failed edit, obligation, build or render. It leaves the current
workspace for inspection and records the failed request and phase in `report.json`.
A failure is never reported as a verified pass.

Output contains the evolving `workspace/`, read-only worker copies in `executor/`,
fresh build/render evidence in `checks/`, and `report.json`. No source snapshots
are used to advance the worker. The integration test verifies a valid result whose
formatting differs from the generator's reference, and a failed second request
that prevents all later requests. This proves the eleven-step slice is executable
without model calls; it does not complete the full restoration benchmark.

## Offline candidate runner (experimental)

The candidate runner uses the same eleven requests, without Pi or model calls:

```sh
flock -n .tmp/renderer-check.lock node scripts/multi-agent/experiments/offline-run.mjs \
  .tmp/renderer-atomic/workspace \
  .tmp/renderer-atomic/trusted/workload.json \
  .tmp/renderer-offline
```

Only the initial project is copied into `workspace/`, once. Each request goes to
an isolated scripted worker. The worker gets neither the full workload nor trusted
contracts, future requests, expected pixels or reference sources. Compilation,
compiler inspection and execution also run in isolation. Each render gets a fresh
output directory and a read-only executable; stale project binaries are not used.

Ordinary binary build outputs may remain in the workspace: they are not decoded
as source or used for verification. C++ sources and headers must be UTF-8.
Symlinks and other nonregular entries are rejected.

The trusted grader checks actual compiled declarations and definition ownership,
active names, preserved compiled function expressions and reference names, and both
scenes rendered twice. The inventory includes the global render driver and project
helpers, not just declarations in the renderer namespace. Unrelated implementations
must stay unchanged; requested moves and names are normalized before comparison.
Different source formatting is allowed. These are conservative checks for this
pinned refactoring slice, not arbitrary C++ equivalence proofs.

A failed build, structure check or render allows at most two corrections after
the first attempt. Earlier edits remain in place. A third failure blocks the chain;
later requests remain unattempted. Timeout, cancellation, executor exit and grader
infrastructure failure stop separately rather than being counted as editing failure.
The happy-path worker is not a general repair agent. The tests also use an isolated
scripted worker that breaks a build, repairs its retained source, then exhausts
three attempts on a later request. The live runner below uses the same correction policy.

`report.json` retains delivered prompts, attempts, source identities, verdicts and
stops. `usage: null` means model usage is unavailable, not zero. `checks/` retains
builds, compiler inventories and images. The trusted `contract.json` stays outside
worker mounts. These artifacts are local evidence, not publication input.

Check the grader against every prepared reference state and an independent final
solution with different source bytes:

```sh
flock -n .tmp/renderer-check.lock node scripts/multi-agent/experiments/verify-grader.mjs \
  .tmp/renderer-atomic \
  .tmp/renderer-scripted/workspace \
  .tmp/renderer-grader-proof
```

The proof output must be new. It derives the contract only from the initial source
and compiler inventory, then builds and grades twelve reference states and the
alternative separately. Reference answers are never mounted into candidate
commands. Its report retains each successful check and any terminal failure.

This is still an experimental eleven-request slice, not the full restoration
benchmark or live-agent continuity proof. Do not interpret a partial check or a
stopped trial as a completed benchmark.

## Packing

Six implementation files are appended in stable order, with nested support source
last. Thirteen headers are then inlined in dependency-safe order. Ordinary headers
are inserted once; redundant includes are recorded and removed. The stb header is
inserted at both include sites because its declarations and implementation are
controlled separately. Its implementation macro becomes active only at the later
site. Include guards and executable code remain intact.

Three translation-unit-local helper conflicts have explicit one-to-one mappings:
shape's `split_middle` and `bvh_max_prims`, and trace's `parallel_for`. Strings are
not changed. Boundary newlines prevent adjoining code from joining. Inverse records
hold hashes, spans, removed directives and helper mappings. They extract current
code rather than saving copies of original implementations.

This is a packer for the pinned fixture, not arbitrary C++. Relative includes and
the fixture's `support/` include root are recognized. A different dependency layout
or source revision needs new compiler/render evidence.

The final operation keeps at most one internal blank code line and removes blank
lines at the beginning and end. It preserves literal bytes and preprocessor
directives, and records only removed whitespace for its exact inverse. Comment-only
lines already disappear during preparation; this operation removes extra original
gaps and packing boundaries. It does not change naming assignments.

## Varied names

`name-vocabulary.mjs` owns a fixed, versioned dictionary of meaningful synonyms
and abbreviations, role-specific affixes and naming forms. It combines partial
word substitutions with prefix-only, suffix-only, substitution-only and mixed
forms, in snake/camel/Pascal spelling. It does not add one universal wrapper.
Meaningless short identifiers and precise math terms keep their meaning; affixes
can still vary their naming form. No prefix claims caching, speed or safety.

Assignment uses stable scope, role, spelling and declaration/family identity.
Independent same-spelling bindings can get different variants. A binding's uses
and redeclarations agree; coupled free-function overloads share a name. Occupied
original spellings and same-scope collisions are avoided deterministically.
Records include vocabulary identity, actual assignments, substitutions, forms,
exclusions and a diversity summary with representative cases. This data is never
part of `payload/`.

A full compiler AST supplies project and vendor declarations, including driver
code. System-header roots are discarded while streaming. Functions/types and
fields use a disposable clangd-18 session against unchanged source. Variables and
parameters use AST declaration bindings, including captures and extern definitions.
Compiler pointer IDs stay in memory only. Declaration offsets use UTF-8 bytes;
inverse edit offsets use JavaScript UTF-16 positions.

Library protocol names, macro-sensitive identifiers and unsupported member/dependent
contexts have recorded exclusions. Macro token pasting can synthesize names with
no physical token to edit; template-dependent members may not have a unique bound
owner. There is no blind text-replacement fallback. A fresh compiler check rejects
incomplete renames. Apart from identifier spelling, naming must preserve literal
bytes and layout exactly. Inactive preprocessor branches are not separately renamed.

## Function mixing

Named generation enables this layer by default; plain packing stays unpermuted.
`function-mix.mjs` selects complete ordinary free functions in named namespaces
from the compiler AST. It adds prototypes, then assigns definitions to compatible
slots using the recorded `renderer-function-mix-v1` seed. Reopened namespaces can
share slots. Types, globals, initialization order and directive order stay fixed.
Declaration availability and directive boundaries limit placement. Compiler type
spellings impose conservative completeness bounds; referenced globals and fixed
helpers impose visibility bounds too. Functions may cross unrelated types/globals,
which stay in place. Repeated standard includes may be crossed,
not moved, only after the actual Clang preprocessor proves that the same include
was already active. Inactive includes are not evidence of prior availability.
Include-only conditional blocks whose includes are all inactive may also be crossed
in this pinned configuration. Blocks with code, nesting, else branches or macro
changes remain boundaries. The report records these boundary proofs. Private types therefore need later prototype
anchors rather than being guessed into early declarations.

Templates, inline/constexpr functions, inferred return types, default arguments on
definitions, macro-dependent code, attributed or nested/friend definitions and body directives
are excluded with reasons. Overload families without all signatures declared before
their region are excluded too. Line-sensitive `__LINE__`/`__COUNTER__` input is rejected.
Introducing prototypes must not change covered compiler bindings: the generator
compares free-function body and global-initializer reference fingerprints before
and after both stages, including resolved members and dependent lookup candidates.
Anonymous type source-coordinate labels are normalized; compiler pointer IDs do not
enter records. A changed binding fails generation, even if the code still compiles.
This is a checked contract for the pinned fixture, not an arbitrary-C++ refactoring
or a proof for every template instantiation and runtime input.

`report.json` has a `mixing` section: selection/exclusion coverage, actual moved
functions, original-source-region moves, unchanged body hashes, prototype and
old/new definition positions, and caller/callee distance examples. Source provenance
is traced through prior packing/naming records. `inputState` and `state` identify
the sources for those positions, before final whitespace cleanup. A fixed point is
reported honestly, not counted as a move. Inverse records hold generated declaration
text and slot/hash metadata; they extract and reorder current definitions without
saving old function bodies. Both new stages and their inverses have fresh render
checkpoints.

## Neutral origin identifiers

Named generation replaces the fixture's `yocto` namespace tokens and `YOCTO_*` /
`_YOCTO_*` macro tokens after mixing and before whitespace cleanup. One neutral
name is chosen from the fixed `renderer-origin-v1` dictionary, using a recorded
seed and deterministic collision avoidance. Uppercase macro spellings agree with
the namespace choice. Five-letter dictionary entries preserve token span lengths,
including physical line-splice positions. Original literals, unrelated identifier
substrings and directive layout are not changed.

Reference routes and requests use the same neutral dictionary name in filenames
and quoted includes. That name remains changed even after restoring working names.
Every reference state, request and candidate source is checked for original project
markers; a leaked filename, guard, namespace, literal or inactive block is rejected.
Ordinary literals are not rewritten to hide a leak. Attribution stays outside the
agent workspace.

The generator rejects a remaining case-insensitive Yocto marker in final payload
code rather than silently rewriting an unsupported literal or identifier. Reports
and reversible token-edit records stay outside payload. Original fixture files and
license/provenance notices remain intact. Plain generation does not mask origins;
other library brands such as stb, Embree and OIDN are not masked. Removing a direct
brand marker does not guarantee that public code cannot be recognized or searched.

## Live Baseline Agent on the eleven-step slice

`live-run.mjs` connects the accepted slice to real Pi RPC. It starts one isolated
Pi process and keeps its conversation, session and workspace through every request
and correction. Only bash is active; the effective system prompt is empty. A small
read-only observer records the actual agent PID inside its namespace, a process
lifetime marker and session ID. A restarted agent does not count as continuity.

Use an explicit private JSON configuration, kept outside Git:

```json
{
  "runtime": "PATH_TO_SEPARATE_PI_INSTALL",
  "model": "PROVIDER/MODEL",
  "thinking": "low",
  "authFile": "PATH_TO_EXPLICIT_AUTH_JSON"
}
```

`runtime` is the installation root containing `node_modules` from a pinned npm
install, not a CLI executable. Readiness was tested with Pi 1.0.1. Optional
`modelsFile` supplies Pi's provider definitions. Optional `envFile` is a JSON map
of explicitly selected provider API keys or auth tokens. No ambient credentials,
personal Pi settings, project extensions, skills or context files are loaded.
Relative paths in this config are resolved from the calling directory.

```sh
node scripts/multi-agent/experiments/live-run.mjs \
  INITIAL_SOURCE WORKLOAD_JSON NEW_OUTPUT PRIVATE_CONFIG_JSON
```

Run in a suitable Linux environment, one heavy verification job at a time under
a shared project lock. Choose resource limits for your environment. Model calls
need separate approval.

The same trusted grader builds fresh and checks compiled ownership, cumulative
obligations and two repeated scenes. A failed candidate gets at most two corrections
without resetting its source. Provider failure, unexpected exit, cancellation,
timeout and grader infrastructure failure stop the chain distinctly. Future
requests and trusted answers are never mounted into the agent.

The output retains `report.json`, `agent-events.jsonl`, session files, the evolving
workspace and grading evidence. Agent timing is separate from grader timing. Usage
comes from finalized native messages and compaction summaries, not streaming
partials. Missing observations stay null; costs use Pi's configured price metadata,
not a provider billing receipt. Retries and compaction events remain in the trace.
These files contain private prompts, commands and model output: do not publish or
commit them as benchmark facts.

### No-cost real-runtime readiness checks

The dedicated tests require the separate Pi runtime explicitly. They are not silent
skips in the normal test suite:

```sh
RENDERER_PI_RUNTIME=PATH_TO_SEPARATE_PI_INSTALL \
  node --test test/renderer/pi-baseline.test.mjs

RENDERER_PI_RUNTIME=PATH_TO_SEPARATE_PI_INSTALL \
RENDERER_INITIAL_SOURCE=INITIAL_SOURCE \
RENDERER_WORKLOAD=WORKLOAD_JSON \
RENDERER_LIVE_OUTPUT=NEW_EVIDENCE_DIRECTORY \
  node --test test/renderer/live-slice.test.mjs
```

A local deterministic provider sends ordinary bash edits from the current request
only. It has no inverse records or expected source states. Real Pi executes those
calls; the trusted grader checks all eleven steps. This proves the runtime path and
benchmark are executable. It is **not** a model score or a paid-model observation.

To exercise the assembled live command without paid inference, replace
`RENDERER_INITIAL_SOURCE` and `RENDERER_WORKLOAD` with
`RENDERER_PILOT_PREPARATION=.tmp/pilot-prepared` in the second command. The test
starts only its local deterministic provider, checks readiness made no provider
requests, then drives all eleven requests through the public live CLI.

The smaller tests also exercise retained edits, corrections, a three-attempt block,
native retry and compaction, provider failure, process exit and cancellation/timeout
cleanup.

## Rebuild a trial report without a model

New offline and live trials retain `attempt-history.jsonl`, an append-only private
history flushed before replacing report views. `sources/HASH/` contains source
copies from before and after each attempt, including failed edits. These copies
are for inspection only; the runner never restores them into the live workspace.

After a trial stops, rebuild its views with:

```sh
node scripts/multi-agent/experiments/chain-report.mjs RUN_DIRECTORY
```

This command reads the history, not the cached `report.json`. It does not start
Pi, compile, render or call a model. It replaces only the derived views:

- `summary.json` and `summary.md`: allowlisted progress, recovery counts, terminal
  cause, observed continuity, timings, tool calls and usage. They exclude prompts,
  raw errors, account identifiers and private machine paths.
- `report.json`: the last complete private report snapshot, restored from the history.
- `timeline.md`: private chronological requests, feedback and runtime observations,
  with links to the source before and after each attempt. Do not share this file,
  the history, source copies or agent traces as safe benchmark summaries.

A partial last history record is ignored and reported. Corrupt complete records,
reordered attempts and changes to finished attempts are rejected. A trial last
saved as running becomes `interrupted`, never a refactoring block. Repeated saves
of cumulative usage do not add tokens again. Missing metrics stay `null`; an
observed subtotal is explicitly partial. Cost uses configured model prices, not
provider billing. Old runs without a history cannot be reconstructed this way;
the command does not invent their missing evidence.

## Batched full-restoration work

The complete scripted route is verified on the worker. It does not change the
eleven-step pilot or claim a full live-model result.
`request-batches.mjs` groups consecutive related requests into batches of at most
20, without mixing structure and naming. The executor receives one short request
at a time. The grader runs only after the whole batch, not between its edits.
A failed batch keeps its current workspace and gets a repair request, rather than
replaying completed moves. After three failed grading attempts the chain stops
without delivering the next batch. Reports distinguish edits from accepted
batches and retain each delivery's before/after source identity.

The bounded header proof starts at the restored-layout monolith from an existing
verified generation. It extracts ordinary project headers, restores direct
includes lost during packing, and checks two repeated scenes before and after
the batch. Its isolated worker sees only the current request and workspace.
The report explicitly lists vendor and implementation files still pending.
It is not the complete restoration E2E or a live-model run.

Run in a suitable Linux environment under a shared renderer project lock:

```sh
node scripts/multi-agent/experiments/verify-header-batch.mjs VERIFIED_GENERATION NEW_OUTPUT
node --test test/unit/renderer-batches.test.mjs test/unit/renderer-extraction.test.mjs
```

`NEW_OUTPUT` must not already exist. Reports, source states and raw render outputs
stay in that private output directory. Header comparison permits blank layout
line differences, but preserves code lines, literals and continued directives.
The proof does not regenerate inputs or repeat the layout/naming reference sweeps.

`implementation-groups.mjs` prepares the next structural requests from an explicit
binding inventory. Shared private helpers, types and data move with all their
users. Header-declared callees do not pull unrelated definitions into a group.
Requests identify current owners/signatures and insertion anchors, preserving
relative definition order even when groups overlap in the original layout.
Unknown references, conflicting selectors and private cross-file dependencies
are rejected rather than skipped. Conditional blocks remain whole units.

`implementation-inventory.mjs` combines compiler bindings with physical source
units, including inactive branches and namespace/directive context. The focused
regressions move real definitions into separate files, preserve initializer order,
and compile both conditional configurations. They do not prove the whole renderer
route by themselves.

### Full scripted restoration

Run the full command in a suitable Linux environment under a shared project lock,
after reviewing its source snapshot and approving the run:

```sh
node src/suites/explicit-edit-multi-agent/grading/verify-full-restoration.mjs VERIFIED_GENERATION NEW_OUTPUT
```

Preparation builds public requests from the verified generation. First restore
whole-definition placement and remove generated declarations. Then extract the
project headers, vendor code and dependency-linked implementation groups. Restore
names only after structure is complete. Filenames, guards and namespace stay neutral;
comments are not restored.

The isolated worker receives one current request at a time. It cannot read private
reference trees, inverse records, future requests, host credentials or the network.
A compiler session is reused within a naming batch. References follow current
binding IDs or semantic rename results, not a project-wide spelling replacement.
Related batches contain at most twenty requests. Build and render the initial state
and completed batches only, using both scenes twice.

`NEW_OUTPUT` must not exist. It retains public requests, every delivered edit's source
identity and changed files, batch source checkpoints, raw scene pixels and a running
report. The final check compares all file owners, code bodies and requested names with
the private reference while allowing whitespace and harmless namespace wrappers.
A failed batch keeps its current edits and withholds later requests. The chain supports
three-attempt repairs, but this happy-path scripted worker has no general English
repair strategy. A partial run or preparation-only report is not a full E2E PASS.

The pinned full fixture has 2,930 requests: 712 structure requests and 2,218 naming
requests, in 155 related batches. Its complete scripted proof passes 156 fresh
build/render checks: the initial state and every batch endpoint. Both scenes match
exact raw float pixels on every check and repeat render. The independently edited
final project has all twenty source files and differs in bytes from the private
reference; complete physical-owner grading still accepts it.

The full report version is `renderer-full-batch-e2e-v1`. Identify each run by its
source snapshot and saved request-file digest, not only its branch or this version
label. Keep `report.json`, `requests.json`, `edits.jsonl` and the checkpoint source
and raw images. The journal records changed source, so read large runs as a stream
rather than loading the whole journal into one string. A successful full scripted
proof establishes executability, not model accuracy or general repair ability.

### Full live run with coarse oracles

After separate approval for model calls, use a verified full scripted proof and
an explicit private Baseline Agent configuration (the same fields as `pi-baseline.mjs`):

```sh
node scripts/multi-agent/experiments/full-live-run.mjs VERIFIED_FULL_PROOF PRIVATE_CONFIG_JSON NEW_OUTPUT
```

Run under a shared renderer project lock. The proof must
have passing report/audit files and the unchanged saved request digest. The agent
starts from its initial monolith, not a previous model's failed workspace. Only
the current tasks and its own workspace are visible to the agent.

This live profile allows **three additional corrections per failed batch**:
one initial attempt and up to three repair attempts. A repair keeps the same Pi
session and workspace; completed moves are not replayed. The oracle says only
“The project does not build”, “The rendered images do not match”, or “The batch
requirements are not met”. It sends no compiler logs, locations, diffs, reference
code or repair hints. The agent can run its own diagnostics. Full errors remain
in private evidence for inspection, never in the repair prompt.

The next batch is withheld until PASS. Four failed checks block the run. Provider,
executor, infrastructure, cancellation and timeout failures stop it immediately.
The batch-attempt limit is thirty minutes. The sequential control has no overall chain limit.
The eleven-step pilot and scripted profile keep their existing three-attempt policy.

The new output preserves `report.json`, actual prompts and execution receipts,
`agent-events.jsonl`, `edits.jsonl`, and source/render checkpoints for each check.
Its report version is `renderer-full-live-oracle-v1`; do not relabel earlier
first-failure runs as oracle runs. Existing output directories are refused.

## Grouped one-hour profile

This separate profile keeps all 2,930 operations, their order and the neutral final
project, but combines consecutive related instructions into ordered lists. Each
list is delivered in **one model request**, not one turn per operation. The complete
prompt is bounded by 96 KiB of UTF-8 text. Lists never mix structure and naming;
the current workload produces 45 lists. This count follows prompt size and group
boundaries, not a fixed task-count target.

The grader runs only after the whole list. A failed list allows three extra coarse
corrections of the current state, without replaying completed moves. The initial
build, agent startup, editing and grading share a **hard 60-minute overall limit**.
Each attempt also keeps its 30-minute cap. Timeout kills the agent's process tree,
retains edits and evidence, and stops without an automatic restart. An unfinished
or late run is not PASS. The sequential control and its old runs stay separate.

In a suitable Linux environment, under a shared renderer project lock:

```sh
# No model calls: reapply every public operation in isolation and verify each new endpoint.
node scripts/multi-agent/experiments/verify-grouped-restoration.mjs VERIFIED_FULL_PROOF NEW_SCRIPTED_OUTPUT
# Only after separate model approval and the scripted proof:
node scripts/multi-agent/experiments/grouped-live-run.mjs VERIFIED_FULL_PROOF PRIVATE_CONFIG_JSON NEW_LIVE_OUTPUT
# Rebuild counts from saved receipts without compiling or calling a model:
node scripts/multi-agent/experiments/grouped-report.mjs RUN_DIRECTORY
```

Keep the existing full proof outside executor mounts. Only its initial source is
copied into the workspace. Saved reference states are grader inputs, never editing
answers. `lists.json` records the ordered lists and their trusted endpoint mapping;
it is outside the live agent's sandbox. `requests.json` retains the unchanged atomic
workload. `report.json`, `edits.jsonl`, `agent-events.jsonl` and `checks/` preserve
attempts, source identities, runtime observations and raw repeated renders.

Reports distinguish verified atomic operations, verified lists, original list
requests and repair requests. Unknown usage stays unknown. The live profile version
is `renderer-full-grouped-hour-v1`; the scripted proof is
`renderer-full-grouped-scripted-v1`. Do not compare or relabel them as the earlier
individual-request control. `grouped-report.mjs` rebuilds summaries from retained
receipts, not a missing or truncated history, and does not resume an interrupted run.

The real-Pi no-cost check exercises one complete list per turn, three coarse
corrections, timeout during initial grading, and killing an active shell child:

```sh
RENDERER_FULL_PROOF=VERIFIED_FULL_PROOF \
RENDERER_PI_RUNTIME=PATH_TO_SEPARATE_PI_INSTALL \
RENDERER_GROUPED_OUTPUT=NEW_EVIDENCE_DIRECTORY \
  node --test test/renderer/grouped-hour.test.mjs
```

## Coherent module goals (`coherent`)

This experimental profile restores the same full renderer through module goals,
then owner-bound naming goals within each module. It does not ask for the old
pairwise definition swaps. Independent definitions may use any dependency-safe
order; harmless include and namespace-wrapper differences are allowed.
The individual-request and `grouped-hour` profiles remain separate controls.

The image-resize goal merges two embedded copies into one header. It keeps the first
copy's guarded declarations and the second copy's macro-controlled implementation,
with their current names and internal inactive alternatives intact. The other two
sections are explicitly redundant and must be removed, not hidden behind new
conditional wrappers. Only `support/stb.cpp` activates the implementation macro.
The delivered selectors state the selected copy numbers and activation file.

This corrected goal changes the task digest. Make a fresh preparation and scripted
proof before another live run; do not reuse old preparation or rewrite saved trial
results. Old two-copy candidates remain useful diagnostic evidence, not passing
solutions to this newly explicit goal.

Prepare from a completed, trusted full scripted proof. Preparation uses current
compiler bindings and public selectors, not saved inverse edits. Run these commands
in a suitable Linux environment, with one heavy job under a shared project lock:

```sh
node src/suites/explicit-edit-multi-agent/tasks/prepare-coherent.mjs VERIFIED_FULL_PROOF NEW_PREPARATION
node src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs NEW_PREPARATION NEW_SCRIPTED_RUN
node scripts/multi-agent/experiments/coherent-report.mjs NEW_SCRIPTED_RUN
```

Each delivered request is one complete module or naming goal with a target table.
The editor sees only that goal and its current workspace. Private preparation,
contracts, future goals, golden images and other source checkpoints are not mounts.
The scripted editor applies only delivered current selectors and compiler-bound
renames. Successful edits survive a later rejected target.

After a goal, the private grader checks a cumulative ledger of physical owners,
bound-name tokens, bodies, literals, macros and inactive branches. Independent
unit order is not part of acceptance. Passing the ledger also requires a fresh
isolated build and two scenes rendered twice with exact raw float agreement.
A simple unconditional standard `using` declaration need not be duplicated when
an earlier project header already supplies it to the remaining consumers, or when
only qualified uses remain. The checker follows real project includes, namespace
scope, declaration order and conditional context for this exception. An unconditional
`std::string_literals` directive may move with a module when literal consumers keep
their context. Extra unconditional standard imports are accepted only when unused
or already supplied through the current headers. An import must not extend an existing
project overload family, even when current calls still select the same functions and
renders remain unchanged. Other namespace directives, aliases and conditional imports
keep their physical contracts.
This is a preservation contract for this fixture, not a general C++ equivalence
checker or a score for arbitrary refactoring.

`checks/LABEL/obligations.json` records individual obligations. A partly satisfied
goal earns no accepted progress. `report.json` keeps complete accepted goals,
attempts, coarse failure categories, source evidence and terminal outcomes.
`coherent-report.mjs` rebuilds a view offline; it does not rerun verification,
authenticate modified artifacts or resume a conversation. Raw reports and source
snapshots remain private.

Live execution needs separate approval and a matching completed scripted proof:

```sh
# Only after approval; use a private baseline configuration as described above.
node src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs NEW_PREPARATION NEW_LIVE_RUN PRIVATE_CONFIG_JSON
```

The live runner uses one pinned Pi 1.0.1 baseline session, bash only and an empty
system prompt. Each failed goal receives at most three coarse corrections, with
no detailed compiler errors or unmet-target list sent by the grader. The agent
repairs its retained workspace. The default `coherent` profile has **no overall or
per-attempt time limit**. A run can continue indefinitely and spend model credit.
Cancel with SIGINT or SIGTERM; the runner closes the agent's process tree, retains
edits and evidence, and saves the result. Cancellation and provider failure are
not editing blocks. Usage that was not observed stays unknown. No restart is automatic.

### Observed completion time

In one local run, **GPT-6.1 Sol with high reasoning and Baseline Agent completed
71/71 goals in about 10.5 hours** (10 hours 28 minutes), with one repair on goal 24.
This run had no overall or per-attempt time limit. Trusted grading took about
5 minutes 23 seconds across the goal attempts; the rest was mostly agent execution,
including tools and provider waits, not just reasoning. Usage and cost were unavailable.
This is an observed completion time, not a promised duration or an official V1 result.
Earlier hour-limited results remain unchanged and are not directly comparable.

The no-cost real-Pi regression checks the untimed default, retained repairs,
a block after three corrections, cancellation and termination of active shell
children. It also checks the explicitly selected legacy hour-limited mode:

```sh
RENDERER_PI_RUNTIME=PATH_TO_SEPARATE_PI_INSTALL \
RENDERER_COHERENT_OUTPUT=NEW_EVIDENCE_DIRECTORY \
  node --test test/renderer/coherent-hour.test.mjs
```

### Explicit legacy and diagnostic modes

Use `--hour-limited` only when you want the old `coherent-hour` policy: a hard
60-minute total limit including grading and closure, and a 30-minute attempt limit.
It is not the default. A timeout remains distinct from an editing block.

```sh
node src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs --hour-limited NEW_PREPARATION NEW_LIVE_RUN PRIVATE_CONFIG_JSON
```

The existing `--diagnostic` option still records a separate diagnostic run:

```sh
node src/suites/explicit-edit-multi-agent/execution/coherent-run.mjs --diagnostic NEW_PREPARATION NEW_DIAGNOSTIC_RUN PRIVATE_CONFIG_JSON
```

This records `coherent-diagnostic`, with both timeout fields set to `null`. It
keeps the same goals, grading, retained edits and three coarse corrections.
It does not replace an old result. Diagnostic scripted runs cannot create or
replace the required preparation proof; successful ordinary scripted runs can,
without a deadline. Every live mode still requires a matching completed scripted
proof. The selected profile and time limits are recorded in each trial report.

## Environment and tests

See [fixture provenance](../fixtures/explicit-edit-multi-agent/PROVENANCE.md). Builds use C++17, `-O0`,
`-ffp-contract=off` and `-pthread`. Rendering uses a fixed seed and the serial path.
Verification establishes exact agreement within Linux x64/Clang 18, not universal
floating-point agreement across compilers, CPUs or libraries.

```sh
node --test test/unit/renderer-bundle.test.mjs test/unit/renderer-preparation.test.mjs
node --test test/unit/renderer-names.test.mjs
node --test test/unit/renderer-permutations.test.mjs test/unit/renderer-markers.test.mjs
```

### Resource use

Renderer preparation and verification can run many fresh builds. Use an environment
with enough CPU and memory and one heavy job at a time under a shared project lock.
For one checkout, the examples use `.tmp/renderer-check.lock`; use the same lock
across checkouts when they share compute resources.

```sh
mkdir -p .tmp
flock -n .tmp/renderer-check.lock npm run check
flock -n .tmp/renderer-check.lock node --test test/unit/renderer-grader.test.mjs
```

The benchmark does not impose a machine-specific CPU or memory budget. Choose any
operator limits explicitly for your environment and retain failed-check evidence
when a limit is reached. Keep deployment policy in private operator instructions.
GitHub pin verification still needs network access. Keep credentials out of command
arguments and tracked files.

Focused tests cover comment/literal boundaries, repeated macro-controlled includes,
shadowing, unrelated owners, overloads, captures, extern definitions and guarded
inverses. Full preparation exercises generation and restoration, fresh builds and renders,
payload completeness, naming and serialized inverse states. Use the Multi-Agent
run guide for the complete preparation and shared-workspace proof.
