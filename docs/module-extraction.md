# Experimental module extraction

This experiment is separate from the public 71-task Multi-Agent suite. It asks
participants to extract whole project files from a generated C++ monolith. It
retains the generated names, declaration order, function mixing and vendor code.
A selected module must have an original header and implementation; required
header-only and vendor dependencies receive separate whole-file assignments.

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
Participants locate complete current units under the shared lock, not by old
snapshot offsets. They retain shared namespace shells and import context.
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
snapshot line numbers. Those coordinates are hints, not edit positions. Participants must re-find
and verify anchors under the shared lock and report unresolved ambiguity rather than guessing.
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

## Recovery and Score

Original file queues finish before a common verification barrier. Participants
remain live through that barrier. A failed file may receive one structural
repair in its original owner's context. Independent repairs can run together;
overlapping work is serialized and refreshed. Build and image correction each
retain their separate bounded fresh-context budget.

The model runner proceeds from the original barrier into structural recovery and
then integration recovery without an operator approval pause. Saved candidates
and reports can be inspected afterward, but a closed run cannot resume the
original participants' contexts. An observation that requires inspection before
each model round needs a live barrier control; the current runner does not
provide one.

The canonical structural credit and build/image factors are unchanged. Header
protection is part of the existing file-transfer check. A matching render alone
does not establish source preservation or a correct header. Model calls require
separate approval; preparing or verifying a case does not authorize a paid run.
