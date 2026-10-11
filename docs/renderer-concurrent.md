# Rotating concurrent editing

The separate public candidate is **Explicit Edit — Multi-Agent**. Start with its
[clean-checkout run guide](multi-agent.md); this document describes the
underlying experiment and scripted execution details.

This experiment uses the complete coherent restoration workload, not a smaller
parallel-only task set. It keeps the same initial shuffled C++ monolith and the
same public tasks. It is separate from V1 results and publication.

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
checkpoint fills the team. A team of one keeps the original task order. Private
contracts and the graph never enter an agent's mount.

Preparation compares cumulative obligations in forward and reverse publication
order within every ready wave, for every supported team size. Every route must
end at the old audited final obligations. This is not enough to declare the graph
safe: the isolated scripted editors must also complete actual shared-workspace
extraction from the initial monolith, with fresh builds and repeated renders.

## One shared project, separate persistent histories

Each agent has its own persistent process and conversation. Every process binds
the same writable workspace. Agents receive only their current public task, not
future tasks, trusted contracts or expected source. Ownership rotates between
agents at checkpoints. There are no separate worktrees whose answers are merged
later.

Every multi-agent assignment and correction states the total team size, how many
other agents share the project, and how many agents have assignments in the current
round. Waiting agents are not counted as current editors. A single-agent run omits
this notice.

After all assigned agents settle, the verifier checks the combined cumulative
obligations, builds a fresh project and renders two scenes twice. Exact pixels
must still match. It also checks that source did not change after the barrier.
Earlier accepted work is part of every later check.

A failed checkpoint allows three corrections with coarse feedback: requirements
not met, build failed, or rendered images differ. Failed source and conversations
are retained; nothing resets to an answer. Exhaustion stops the jointly verified
prefix. The runner does not invent individual scores for a failed team checkpoint.
Provider, driver and infrastructure failures are separate from editing failures.
There is no overall or per-attempt deadline by default; cancellation remains active.

## Scripted reference and resource use

The reference editor plans against the current shared source, then uses a short
compare-and-commit lock. A stale snapshot writes nothing; the editor rereads and
replans. Multi-file publication and consistent reads use this same lock. Planning
happens outside it. Live agents are not required to use this editing technique.

Reference receipts are emitted only after owned compiler-slot cleanup finishes.
Empty reference control directories are not source, and their removal may overlap
with another worker's read. Nonempty control directories are rejected rather than
allowing candidate code to hide inside them.

Full-project compiler ASTs are memory-heavy. The reference has two overlapping
compiler slots, shared by the persistent agents, and a disposable compiler child
for each planning attempt. This bounds reference memory without reducing the
benchmark team or restricting live tools. Reference planning, source publication
and agent concurrency are different things; the report records the reference
slot count separately. Safe reference conflicts are counted, not graded as failures.

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
for that exact team schedule. A live run refuses missing or mismatched proof.

The native Pi regression scenario uses a local deterministic provider, no paid
model calls. It exercises overlapping delivery, separate persistent sessions,
rotating ownership, retained peer edits, correction exhaustion and cancellation:

```sh
RENDERER_PI_RUNTIME=PATH_TO_PINNED_PI_RUNTIME \
RENDERER_CONCURRENT_OUTPUT=.tmp/concurrent-native-proof \
  node --test test/renderer/concurrent.test.mjs
```

## Explicit live execution

Live execution needs separate approval and a private provider configuration in
the same format as the coherent Baseline Agent runner. It uses pinned Pi 1.0.1,
bash only and an empty system prompt:

```sh
node src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs \
  .tmp/concurrent-prepared .tmp/concurrent-live auto PRIVATE_CONFIG_JSON
```

Reports record the task/graph/schedule identities, actual assignments, execution
timings, receipts, jointly accepted prefix and saved failed checks. Operating-system
commit order is observed, not prescribed or claimed to be reproducible. Keep raw
reports, failed source, credentials and local machine settings out of Git and
publication. This experiment does not publish results automatically.
