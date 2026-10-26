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

The experimental command's default team size is the maximum antichain of the
derived DAG. The scored protocol fixes 15 agents, all 71 tasks and 28 barriers.
Each barrier's atoms are split evenly across the team, keeping each dependency
chain whole and in order with one agent. Small barriers use fewer agents;
barriers are not merged to occupy the team. A team of one keeps the original
task order. Private contracts and the graph never enter an agent's mount.

Preparation compares cumulative obligations in forward and reverse publication
order within every ready wave, for every supported team size. Every route must
end at the old audited final obligations. This is not enough to declare the graph
safe: the isolated scripted editors must also complete actual shared-workspace
extraction from the initial monolith, with fresh builds and repeated renders.

## One shared project, separate persistent histories

Each agent has its own persistent process and conversation. Every process binds
the same writable workspace. Agents receive only current public edits, not future
tasks, trusted contracts or expected source. Each agent's share is a queue of
messages, with a configurable limit of 50 atoms per message by default. The value
is experimental and can be lowered without changing task content. Only a returned
harness turn advances the queue; the controller does not interpret reply text.
There are no separate worktrees whose answers are merged later.

Every multi-agent assignment and correction states the total team size, how many
other agents share the project, and how many agents have assignments in the current
round. Waiting agents are not counted as current editors. A single-agent run omits
this notice.

Only after all queues and harness turns have drained does the verifier check the
combined source. Intermediate states and individual atoms are not graded. A
per-file symbol map from Clang 18's libclang compares declaration USRs, declaration
and body tokens, and referenced USRs against the expected snapshot. Declaration
order within a file and reopened namespaces do not matter. Synthesized local
constructor/destructor names use their owner, kind and relative declaration token,
not Clang's location-bearing anonymous-type label. Distinct local types remain
distinct. Macros, inactive branches and locals remain lexically protected. Earlier
accepted work is part of every later check.

Accepted barriers publish immutable `checkpoints/<round-id>` directories containing
the source snapshot, accepted-prefix progress, queue rotation and workload/schedule
bindings. A checkpoint marker is published last; an interrupted write is not a
usable checkpoint. Conversation histories and credentials are not checkpointed.

For recovery from a verified benchmark or runtime defect, the runner API accepts
`resumeFrom` (a checkpoint directory) and an explicit `recoveryReason`. It verifies
the snapshot and rechecks cumulative structure, compilation and repeated pixels
before opening fresh participant sessions. Earlier accepted atoms are not
redelivered. A recovered run is diagnostic-only and unscored, with its parent report
hash retained; original evidence is never rewritten. Delivery, repair, usage and
elapsed metrics describe the new segment, while accepted progress includes the
revalidated prefix. Recovery must not reset attempts after a genuine model failure.

A fresh build and two scenes rendered twice must pass with exact pinned pixels.
The verifier also checks that source did not change after the barrier. A returned
turn grants no task credit.

A failed checkpoint allows five corrections, for six attempts in total, without
resetting source or conversations. File-grouped repairs are split evenly across
the whole team without original-executor attribution. The
[run policy](multi-agent.md#run-policy-and-score) defines the priority and exact
feedback: fresh current source/binding problems first, then compiler errors when
the map is clean, then one coarse pixel mismatch item. Current compiler facts
and already-public requirements identify unsatisfied names, ownership and module
setup. Completed work is not resent. Repairs have new IDs, empty original-atom
coverage and no historical-task payload. Private map tokens, USRs, reference
source and preparation plans never enter feedback.

Exhaustion stops the jointly verified prefix. The runner does not invent
individual scores for a failed team checkpoint. Provider, driver and
infrastructure failures are separate from editing failures. There is no overall
or per-attempt deadline by default; cancellation remains active.

## Scripted reference and resource use

Each reference participant owns a private planner, compiler view and retained
edit history. Planning remains independent and concurrent. Each requested file
patch protects its latest read, merge and atomic replacement with an ordinary
inherited-descriptor `flock`, available to a Bash participant. An inode check
makes a waiting writer reopen a file replaced by a peer before reading it.
Creating a file briefly protects its parent directory and rechecks absence.
There are no lock files, shared planner or mandatory editing service. Other
files remain writable, and multi-file intermediate states remain visible.
This participant-owned protocol does not protect arbitrary writes that bypass it.

The scripted reference must pass every drained barrier on its first check.
It cannot dispatch barrier repairs or authorize measured runs with a recovered
proof. Measured participants retain the separate six-attempt policy described
above. Private planning and resolving an obsolete edit are editor work, not
barrier acceptance. Actual working, planning and publication overlaps are
recorded as evidence.

A restored project header can remain inside other header guards in the shared
monolith. Fresh module repairs locate its unique current guard, including nested
guards, and preserve an existing destination header. Ambiguous or incomplete
blocks remain explicit inspection work; an editing receipt still grants no credit.

Current compiler errors prioritize existing naming goals at their locations or
with matching required names. Other goals and errors remain in the repair queues.

A repair can reach an editor that never handled the original request. For a
rename already present in current source, it resolves every destination selector
through the compiler before choosing a no-op. A fresh field, namespace-variable
or function repair can use a complete recovery AST from actual translation units when current
source errors prevent strict analysis. It must still match the physical declaration,
role and scope; a namespace-variable repair cannot select a function-local binding.
Recovered function repairs also require the current owner signature and declaration/definition role.
Recovery views are disposable and cannot certify ordinary naming work. Infrastructure
failures and incomplete ASTs remain conflicts. All source errors still fail barrier
grading, including unrelated errors left after a repair. No editor query grants credit.

Full-project compiler ASTs are memory-heavy. Persistent participants own and
clean up their compiler views independently. Reference resource use does not add
a shared editing service or serialize the team.

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
independent edits, retained peer edits, correction exhaustion and cancellation:

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
