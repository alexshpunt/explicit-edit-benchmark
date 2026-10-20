# Rotating concurrent editing

The separate public candidate is **Explicit Edit — Multi-Agent**. Start with its
[clean-checkout run guide](multi-agent.md); this document describes the
underlying experiment and scripted execution details.

The diagnostic route uses the complete coherent restoration workload, not a
smaller parallel-only task set. It keeps the same initial shuffled C++ monolith
and 71 parent scoring groups, split into atomic requests. Its direct Pi commands
below are not the harness-independent common run and publication route.

## Find safe parallel work first

`prepare-concurrent.mjs` reads an audited coherent preparation and its completed
scripted proof. Dependencies come from moved or renamed code, required project
includes, current owner files and selector spellings. It does not chain module
extraction by task number or make all naming tasks wait for the entire layout.
Only the final whole-monolith cleanup waits for all module moves.

Moving an embedded guard changes the recorded conditions and macro context of
neighboring declarations without editing those declarations. Those bookkeeping
changes are not ownership conflicts. Private checkpoint contracts are rebuilt
from the untouched input and the selected public module moves, then composed
with the audited naming deltas. They never use candidate source as the answer.
All bodies, literals, inactive branches and macro contexts are still checked.

The default team size is the maximum antichain of the derived DAG, not a hardcoded
model setting. Its width is a potential concurrency limit, not a claim that every
checkpoint fills the team. A diagnostic team of one keeps the original parent-task
route. Private contracts and the graph never enter an agent's mount.

Preparation compares cumulative obligations in forward and reverse publication
order within every ready wave, for every supported team size. Every route must
end at the old audited final obligations. This is not enough to declare the graph
safe: the isolated scripted editors must also complete actual shared-workspace
extraction from the initial monolith, with fresh builds and repeated renders.

## One shared project, separate persistent histories

Each agent has its own persistent process and conversation. Every process binds
the same writable workspace. Agents receive only their current public task, not
future tasks, private binding plans, trusted contracts or expected source. Each
free participant receives one ready atomic request; ownership rotates at actual
dispatch, not just at checkpoints. A busy participant cannot receive another
active request. There are no separate worktrees whose answers are merged later.

Every multi-agent delivery states the persistent team size and the current
number of active editing deliveries. Waiting participants are not counted as
current editors. The public scored suite fixes the pool at 15; smaller diagnostic
teams do not become scored observations. See the [stream policy](multi-agent.md#run-policy-and-score)
for verified-only dependencies, pending peer observations and correction behavior.

Lightweight gates verify atomic outputs between deliveries and recheck inputs
before dependent dispatch. At each full barrier, all active writers drain before
the verifier checks cumulative obligations, builds a fresh project and renders
two scenes twice. Exact pixels must still match. It also checks that source did
not change after grading. Earlier accepted work is part of every later check.

A failed full barrier allows five corrections after the initial attempt. Source,
conversations and still-valid atomic completions are retained; nothing resets to
an answer. If all atoms remain verified but full grading fails, one participant
receives a global barrier repair within that same six-attempt budget. Exhaustion
stops the jointly verified prefix. Only the original parent groups earn Score
credit; there is no individual-agent score. Provider, driver and infrastructure
failures remain separate from editing failures. There is no overall or per-attempt
deadline by default; cancellation remains active.

## Scripted reference and resource use

The reference editor plans against the current shared source, then uses a short
compare-and-commit lock. A stale snapshot writes nothing; the editor rereads and
replans. Multi-file publication and consistent reads use this same lock. Planning
happens outside it. Live agents are not required to use this editing technique.

A settled delivery does not close the shared compiler analysis. The last
participant closes the planning service; cancellation waits for owned namespace
teardown, including compiler children, before settlement. Empty reference control
directories are not source, and their removal may overlap another worker's read.
Nonempty control directories are rejected rather than allowing candidate code
to hide inside them.

Full-project compiler ASTs are memory-heavy. Persistent reference participants
share one isolated current-task planning slot. It accepts only requests already
dispatched to those participants, never future tasks, prepared token plans, gates
or expected trees. Compatible analysis is reused only while acknowledged reference
edits explain the actual source; incompatible or unexplained changes invalidate
it. Owned namespaces close before cancellation settles.

One analysis slot is not a one-agent limit: reference planning, source publication
and participant concurrency are different things. It does not restrict live tools
or reduce the public 15-participant pool. Reports disclose reference slot use
separately. Safe reference conflicts are counted, not graded as failures.

The compiler's combined project view is only a fast path. If it cannot compile,
reference analysis falls back to the actual separate translation units and merges
consistent physical binding edits. Equal private `static` names in different
units are legal; they must not create false benchmark dependencies. Every requested
mapping must still have a selected owner somewhere in the combined plans.

Live conflict counts and causal lost-update attribution remain unknown unless
there is direct evidence. A missing previous obligation is observable, but alone
it does not prove which writer caused it.

## Run without a model

Run renderer checks in a suitable Linux environment, under a shared project lock.
All output directories below must be new. Start with a completed coherent
preparation whose tasks, contracts and scripted proof agree:

```sh
node src/suites/explicit-edit-multi-agent/tasks/prepare-concurrent.mjs \
  .tmp/coherent-prepared .tmp/concurrent-prepared
node src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs \
  .tmp/concurrent-prepared .tmp/concurrent-scripted
node src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs \
  .tmp/concurrent-prepared .tmp/concurrent-single 1
```

The default team is graph-derived. An explicit team must be an integer from one
to the calculated width. A successful scripted run saves `verification-N.json`
for that exact team schedule and atomic workload/binding/dispatch identities.
A live run refuses a missing, coarse-only or mismatched proof. A graph check or
partial certification cannot replace actual completion through all full barriers.

The native Pi regression scenario uses a local deterministic provider, no paid
model calls. It exercises overlapping delivery, separate persistent sessions,
rotating ownership, retained peer edits, correction exhaustion and cancellation:

```sh
RENDERER_PI_RUNTIME=PATH_TO_PINNED_PI_RUNTIME \
RENDERER_CONCURRENT_OUTPUT=.tmp/concurrent-native-proof \
  node --test test/renderer/concurrent.test.mjs
```

## Explicit live execution

The following diagnostic Pi route needs separate model-run approval and a private
provider configuration in the coherent Baseline Agent format. It uses pinned
Pi 1.0.1, bash only and an empty system prompt. For another harness or a public
observation, use the [common run path](multi-agent.md#common-run-and-submission)
instead:

```sh
node src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs \
  .tmp/concurrent-prepared .tmp/concurrent-live auto PRIVATE_CONFIG_JSON
```

Reports record task/graph/schedule and atomic identities, actual dispatches,
participant assignments, atomic output checks, execution timings, native receipts,
retained and invalidated completions, jointly accepted prefix and saved failed checks. Operating-system
commit order is observed, not prescribed or claimed to be reproducible. Keep raw
reports, failed source, credentials and local machine settings out of Git and
publication. This experiment does not publish results automatically.
