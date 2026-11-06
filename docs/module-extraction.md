# Experimental module extraction

This experiment is separate from the public 71-task Multi-Agent suite. It asks
participants to extract whole project files from a generated C++ monolith. It
retains the generated names, declaration order, function mixing and vendor code.
A selected module must have an original header and implementation; required
header-only and vendor dependencies receive separate whole-file assignments.

## Chunk teams

The `chunk-*` commands run a flat case with ten-agent teams over small fragment
assignments: all files except `frond_math.h` first, then `frond_math.h`. Each
delivery has a 120-second limit. Structural, build and result corrections follow
the common schedule, and the round is scored by structural unit differences from
the marker-free scaffold to the trusted endpoint. Commands, the scripted reference
and the Score are described in [Line difference score](structural-unit-score.md);
chunk runs keep the earlier structural unit policy described there.
Chunk runs are not repeated; the two-phase assembly below replaces them. Their
reports keep their meaning. The sections after it describe the earlier
whole-file and per-file protocols.

## Two-phase assembly

The `assembly-*` commands run a flat case in two phases on one `main.cpp`,
followed by the common correction schedule and one line difference score.

1. **Assembly.** The scaffold inserts one `#pragma region FILE` …
   `#pragma endregion` block per future project file, in unity-build order:
   headers after the project headers they include, then implementation files.
   Each region holds the file's system includes and copied `using` lines and one
   placeholder comment line per assignment item, in reference order. The
   original units stay where they are and carry no markers. Twenty agents move
   items into their regions concurrently, all editing the same `main.cpp`.
2. **Extraction.** One assignment per region moves the whole region into its
   file: header files start with `#pragma once`, every file then gets the
   project includes of its reference preamble, and a header region is replaced
   in `main.cpp` by its include line. Agents work on the `main.cpp` that
   assembly left, not on a trusted copy.
3. One structural correction, one build correction and one result correction.
   There is no correction between the phases.

Structural corrections name units without their text: a named unit by kind,
signature and namespace, as in assignments, and an unnamed block by its first
and last line. One assignment per file lists its problems:

- a unit, or a run of consecutive units, that belongs at another place or in
  another file: where it is now, where it belongs (between which units or
  lines), and that it moves unchanged;
- an extra copy of a unit, with where its required copy is;
- a unit that is missing although an identical copy exists elsewhere, which
  stays where it is.

Only a unit whose exact text exists nowhere in the project, such as one that
lost its closing `};`, is given in full, with the place of its changed version.
Lines outside units, stray lines, extra files and non-text entries are described
as they are, with their surrounding lines; an extra file holding units is
deleted after they move out. A unit counts as in place when one of its copies
is matched, at least in part, to its own reference lines; its remaining
differences then stay line corrections. Policy version 6 introduced this
wording; earlier assembly policies quoted every differing line.

Assignment items never contain the text of a named unit. A function, function
declaration, class, struct, union or enum is named by kind, signature with
collapsed spacing, and namespace; the agent finds it and its boundaries. When
`main.cpp` holds several copies that differ only in spacing, the assignment says
so and asks for one. Adjacent units without such a name (variables, aliases,
directives) form one block when only whitespace separates them in the source and
in the destination. A block assignment gives its first and last line, its
complete text, and the nearest named units before and after it, stated as their
position in the original `main.cpp`. Preparation rejects a named description
that matches different code and a block that its text and neighbours do not
identify.

Assembly deliveries hold at most ten items and about 2 kB, as before. They form
one queue that interleaves regions: the first delivery of every region, then
every second delivery, and so on. A free slot takes the next delivery. The
agent lifecycle of assembly and extraction is chosen per run:

- `per-delivery` (default): every delivery starts a new agent with an empty
  context; the general instructions precede its assignment, and the agent is
  closed when its delivery ends.
- `persistent`: each of the twenty slots keeps its agent, so the agent takes
  the next delivery with its whole history, about 27 assembly deliveries per
  agent. The general instructions precede only its first assignment. A delivery
  that reaches the limit closes the agent, and the slot starts a new one for its
  next delivery. Assembly agents are not carried into extraction; with fewer
  regions than slots, every region still gets its own agent.

Corrections always start a new agent for every assignment. The lifecycle is part
of the run policy and the report, and usage is recorded once per agent session;
compare scores only between runs with the same lifecycle. Startup does not count
toward the 300-second limit. The limit bounds a run without cutting off slower
models; policy version 1 used 120 seconds. The
controller never repairs source, regions or placeholders and never rewrites an
assignment. Placeholders still present after extraction are removed before the
first capture and counted in the report.

`N` runs from the scaffold without placeholders to the final reference: the
assembled regions moved into their files, with `main.cpp` keeping one include
line per header where the regions were. Version 1 assembly runs counted
structural units; version 2 counts line differences, so a lost brace costs only
the lines that differ. Every assessed stage of the report also records file
exactness: how many reference files have no line difference, which reference
files differ and which extra files exist. The command summary prints it for the
first and the final capture, such as `12/20`. It stands next to the Score and
does not change it: a run can lose few lines and still leave many files
inexact. The scripted
reference also builds the assembled unity build, all files still in their
regions; it and the final files must render the expected images.

```sh
node scripts/module-extraction.mjs assembly-verify FLAT_CASE NEW_REFERENCE
node scripts/module-extraction.mjs assembly-run FLAT_CASE NEW_RUN --config PRIVATE_JSON --proof NEW_REFERENCE/summary.json --allow-model-calls
node scripts/module-extraction.mjs assembly-run FLAT_CASE NEW_RUN --config PRIVATE_JSON --proof NEW_REFERENCE/summary.json --agent-lifecycle persistent --allow-model-calls
node scripts/module-extraction.mjs assembly-probe FLAT_CASE NEW_PROBE --deliveries 40 --config PRIVATE_JSON --allow-model-calls
node scripts/module-extraction.mjs assembly-probe FLAT_CASE NEW_PROBE --regions frond_noise.h,frond_bvh.cpp --scripted
```

`assembly-verify` is the scripted reference: it applies every assignment exactly
with twenty concurrent scripted participants and must report Score 100 from
clean committed source. `assembly-probe` is a diagnostic. It runs the first
deliveries of the assembly queue, the extraction of chosen regions, or both;
extraction alone starts from the assembled reference. It compares the result with
the scripted outcome of the same assignments and reports disagreements without
corrections, build or Score.

## Flat CPU diagnostic profile

The separate `flat-prepare` profile derives an active CPU-only source from an
existing version 5 paired case. It runs Clang in directives-only preprocessing
mode and maps active lines back to their authenticated original owners without
expanding macros. It removes supported `frond` namespace shells and qualifiers
and qualifies supported `std::hash` specializations. Unsupported source layouts
fail preparation. The active vendor declaration and implementation become
separate assignments; historical cases and reports are unchanged.

`flat-verify` rebuilds the parent ownership and compiler projection, checks each
of the 19 reference assignments separately, and builds and renders both the
monolith and complete extracted tree twice. Both scene hashes must match the
parent. These fixed-scene comparisons do not prove general semantic equivalence.
`flat-run` assigns the files to ten fixed participant contexts and starts only
one participant process at a time. Each process handles its assigned files one
at a time and closes before the next participant starts. After each delivery the
controller assesses and freezes the shared candidate, then requires inspection
of that exact snapshot before the next task.
The final candidate is built and rendered only if the full structural check passes.
`flat-debug` requires that proof, a private model configuration, explicit model
call authorization, one task ID and inspection. Every invocation starts one
participant on one task in a fresh workspace; it reports structural diagnostics,
not a full benchmark score.

```sh
node scripts/module-extraction.mjs flat-prepare PARENT_CASE NEW_CASE
node scripts/module-extraction.mjs flat-verify NEW_CASE NEW_REFERENCE
node scripts/module-extraction.mjs flat-run NEW_CASE NEW_RUN \
  --config PRIVATE_JSON --proof NEW_REFERENCE/verification.json --allow-model-calls
node scripts/module-extraction.mjs flat-debug NEW_CASE NEW_RUN \
  --config PRIVATE_JSON --proof NEW_REFERENCE/verification.json \
  --allow-model-calls --task extract-001
```

Use a fresh ignored output directory for each command and hold the shared renderer
lock for preparation and verification. Keep private configurations and raw
results local.

## Header contract

Fresh paired cases use `#pragma once` for the project's own headers. The final
reversible generation step removes only their ordinary outer `#ifndef`,
`#define` and matching `#endif` directives from the monolith. It rejects ambiguous
guards and unsupported dependencies on guard macros. Token-paste vocabularies
capable of spelling a guard are unsupported. Internal conditions, vendor
protection and activation-macro/include
ordering remain unchanged. No `#pragma once` is inserted into `main.cpp`.

Each own-header assignment requires exactly one `#pragma once` as the first
non-empty line, with no include guard. Structural
verification checks this requirement independently of successful compilation.
Missing, duplicate, inactive or misplaced pragmas and retained old guards fail
that file's transfer obligation; they do not create a new scoring stage.

Generation replay tracks each source unit back to its original file. Header
ownership therefore does not depend on guard envelopes in the current source.
Participants locate complete current units, not old snapshot offsets. They retain shared namespace shells and import context.
Insert each extracted project-header include at its first owned unit's current
global position, before the outermost containing namespace opener when needed.
Leave preceding source and imports in place; do not hoist or sort the includes.
This retains external-header macro context as well as activation-macro ordering.
Temporary header-local macro overrides require matching literal-preserving
conditions, one definition and a matching cleanup, with no include while the
override is active. Unsupported macro lifetimes or dependencies fail preparation.

## Scattered input

Generate an aggressively scattered input with the experimental profile:

```sh
node src/suites/explicit-edit-multi-agent/generation/run.mjs \
  generate-extraction-scatter NEW_GENERATION
```

The profile is deterministic. It moves eligible complete namespace-level
functions, including supported `inline` definitions, across compatible slots.
It searches for more moved definitions, then scores same-source separation and
displacement. It retains a per-source separation floor using final byte positions,
including shifts caused by moving definitions of different lengths. The generation
report records the search budget, convergence, coverage and cross-source bounds.
One bound accounts for slot dependency limits;
neither accounts for the per-source separation floor. These bounds do not prove
a globally optimal permutation.

The generator checks compiler bindings and builds and renders every checkpoint.
Unsupported templates, `constexpr` definitions and other unsafe units remain
in place. The ordinary public suite generation retains its existing profile.
Use the generated journal and matching preparation to prepare the extraction
case, and verify the chosen input with the language server and scripted editors.

## Agent assignments

Fresh version 5 cases provide explicit file obligations alongside the public symbol inventories.
They describe preprocessing barriers, conditional membership, copied imports, vendor phases,
source removal and replacement placement. They also explain which rearrangements structural
comparison accepts and require preservation of compiler bindings, which structural comparison alone
does not prove. Unsupported or unresolved source ambiguity fails preparation rather than being
assigned by guesswork.

When ownership or a macro definition is ambiguous, assignments include exact source anchors and
snapshot line numbers. Each displayed exact excerpt has a length, ending and digest so its boundary,
including any final newline, can be verified independently of the code fence. Coordinates are hints,
not edit positions. Participants must re-find and verify anchors in the current source and report
unresolved ambiguity rather than guessing.
The same requirements and selected anchors are available during recovery. A scripted reference
uses private ownership data; passing it does not by itself prove that a model can solve the task.

The historical version 4 assignment format works as follows. Each agent receives prose describing its destination file and a sorted inventory of its entities:
namespace, kind and exact signature. Agent-facing assignments and recovery messages do not contain
serialized structured data. Exact `using` declarations, repeated
occurrence counts and destination dependencies are included. Shared `using`
declarations are marked for copying. Some type entries include member signatures
to distinguish different types with the same name. The inventory has no source
positions, neighbouring anchors, function bodies or destination template. The
same boundary applies to recovery messages and their assignment files; an agent
may inspect the workspace and run the supplied integration validation script.

During structural recovery, compare the latest frozen candidate with the private
reference and report identifiable missing, extra or changed assigned entities by
their public signatures. Report unexpected candidate macro names, includes and
files without copying their contents. Preserve occurrence counts and public member
declarations when distinguishing vendor entities. Unsupported or ambiguous syntax
may limit these details; do not infer a missing entity from an incomplete parse.
Diagnostic feedback does not disclose private reference bodies or diagnostic locations.
The version 5 assignment files may separately provide exact original-source context
and snapshot coordinates where needed to identify ambiguous ownership.

Preparation rejects unsupported syntax and ambiguities it cannot resolve. The scripted
reference retains private ownership data for execution and verification; it is not
mounted for model participants. A passed scripted reference establishes the checked
extraction, not that an agent can independently solve it from the inventory.

## Model-free reference

Use the renderer prerequisites and shared-worker rules in [the Multi-Agent
run guide](multi-agent.md). On the worker, under the shared project lock:

```sh
node scripts/module-extraction.mjs prepare PREPARATION NEW_CASE \
  --generation GENERATION --modules frond_shape --agents 1
node scripts/module-extraction.mjs verify NEW_CASE NEW_REFERENCE_RUN
```

Use fresh ignored output directories. `prepare` derives a new generation journal;
it does not modify its input preparation or journal. `verify` uses isolated
scripted editors, then checks structure, compilation and both reference scenes.
These editors verify the machinery, not a model's extraction ability.

Fresh paired artifacts use case version 5, plan version 3 and proof version 7,
with the `explicit-inventory-v2` assignment contract. Earlier artifacts remain
loadable and retain their original reconstruction and proof rules, but their
incomplete assignment contracts cannot authorize model execution. Historical
inputs, candidates and reports must not be rewritten.

## Isolated task diagnostics

For debugging, `debug` runs each selected assignment in a separate copy of the
original source and a new participant session. It first runs the scripted
reference independently on every selected assignment; any failure stops the
model before it starts. The normal clean-source reference proof is still
required. Each finished candidate and its individual report must be inspected
and approved before the next task starts. A failure is retained and does not
change the next task's input. To diagnose one task, add `--task TASK_ID`.

```sh
node scripts/module-extraction.mjs debug CASE NEW_DEBUG_RUN \
  --config PRIVATE_JSON --proof REFERENCE_RUN/verification.json --allow-model-calls
```

The `preflight` and `model` directories contain separate diagnostic reports and
snapshots. The only quality assessment compares the assigned destination, residual
source, unrelated files and physical inventory against a one-task reference.
C++ peer units are sorted within their namespace and conditional branch, between
preprocessor barriers. Directives and conditional blocks retain their order, and
units cannot cross them. Reopened plain named namespaces without preprocessing
may be combined or empty within a segment. Multiplicity, full unit contents, class
member structure and conditional ancestry remain significant. Non-C++ files are compared losslessly. This diagnostic
comparison does not establish compiler bindings. A partial extraction may depend on files belonging to other
assignments, so diagnostics do not build, render, run recovery or produce a
benchmark score. They are not benchmark observations. The ordinary `run`
continues to use its shared candidate and normal scoring.

## Recovery and Score

Original file queues finish before a common verification barrier. Participants
remain live through that barrier. A failed file may receive one structural
repair in its original owner's context. Model tasks and repairs run one at a
time, with a fresh inspection after each one. Build and image correction each
retain their separate bounded fresh-context budget.

Before each original round and each recovery batch, the model runner displays a
snapshot path, report path and candidate hash. Inspect the snapshot and report,
then enter `approve <inspection number> <candidate hash>` to continue. A changed
workspace, wrong approval, closed input or cancellation stops the run. The runner keeps the
participant contexts alive while waiting; a closed run cannot resume them.
Each approval permits one delivery. For transient provider errors, the runner
keeps the same session and retries at most three times per delivery, with a
60-second cooldown before each retry. Billing, quota and authentication errors
stop the run.

For a chunked team run, both original teams finish and close before the
controller captures the initial structural differences. A separate fresh team
receives all of those differences in one repair wave. Repairs are serialized,
but structure is not verified again until the final check.

After structural repair, the controller checks the build and, if it succeeds,
both images. A failed build receives one build correction. A failing image check
or a build that remains broken receives one final result-recovery attempt. The
controller then checks structure, build and images one final time. No further
attempt is allowed. When the final build fails, images are unavailable and both
integration factors are 0.5.

The structural Score starts with one point per assigned fragment. A fragment
fails when its source or destination obligation fails. Identical copies are
counted by multiplicity rather than individually attributed. Preservation
failures remain separate differences. Each initial difference costs one point;
an initial difference absent at the final check returns half a point. Each
final difference absent initially costs one point. Normalize this balance to
the fragment count and clamp it between zero and one.
Multiply it by the build and image factors: 1 for first-pass success, 0.75 for
success after correction, and 0.5 for final failure or an unavailable result.

The checker always returns a result for any candidate. A changed unit of the
same kind as a failed fragment counts as that fragment's damaged copy. Other
unattributed code, unreadable files and lost unrelated code are preservation
differences.

Initial and final evidence, correction attempts and the shared team Score are
retained separately. An interrupted run has no final Score. Structural feedback
uses public information and may fail to localize a defect. The new final-snapshot
policy is versioned independently; prior scoring policies and saved reports
retain their original meaning.

Each chunk or repair delivery has a 120-second execution deadline. A timed-out
participant is stopped and its process boundary is drained before it is retired;
partial edits remain in the shared project. The delivery is recorded
as timed out and is not retried. Surviving participants continue the queue; if
none remain, unissued work is recorded and the controller proceeds to verification.
External cancellation and infrastructure failures are not successful deliveries.

A completed single-snapshot team experiment can report its unassisted Score with
`scoreExtractionSnapshot`. The calculation uses the existing extraction policy,
including preservation differences and build/image factors. It describes the
shared candidate, not individual participants. When correction has not run,
`structural.correctionComplete` remains false; the score does not imply that the
recovery budget was used. The report retains the structural and integration
components alongside the numerical Score.

The canonical structural credit and build/image factors are unchanged. Header
protection is part of the existing file-transfer check. A matching render alone
does not establish source preservation or a correct header. Model calls require
separate approval; preparing or verifying a case does not authorize a paid run.
