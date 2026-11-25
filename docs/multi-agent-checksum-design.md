# Multi-Agent checksum project: task design

Status: draft for review. Nothing here is measured yet except where a result is cited.

The next Multi-Agent version replaces the pinned renderer input with a generated C++
project. A seed fixes one `main.cpp` whose functions add weighted contributions to a
checksum that `main` prints. Every task is a mechanical edit stated as exact text, as
in the original Explicit Edit suite. A task has exactly one correct result, and no two
tasks edit the same text, so the reference does not depend on the order in which
agents finish.

## What a run measures

Each edit belongs to one of five clusters. A cluster isolates one way an edit can go
wrong. Every cluster has a trap variant, which contains the difficulty, and a control
variant, which is the same kind of edit without it. The cluster result is the pass
rate of its traps next to the pass rate of its controls; the difference is the cost
of that difficulty for the harness, separate from how careful the model is in
general.

A run reports a profile per cluster. There is no single total, because the clusters
are not comparable with each other and some favour different tools.

Two execution modes run the same tasks:

- Isolated: every task goes to a new agent in its own copy of the start project. A
  task passes when its `main.cpp` equals the task's reference byte for byte. This is
  precision.
- Shared: all agents start, wait at a barrier, then receive their tasks at the same
  moment and edit one `main.cpp`. Each edit is checked in the final file, together
  with whole-file integrity, the build and the printed checksum. Robustness is the
  shared result minus the isolated result, per cluster.

## Clusters

| Cluster                | Failure it catches                                                   | Trap                                                                                                                                                  | Control                                                                                                | Likely easier for                        |
| ---------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| A. Completeness        | A missed occurrence, or an edit inside a longer identifier           | Rename a global constant with 12 to 20 uses where longer identifiers contain its spelling (`gain_rate` next to `gain_rate_limit` and `max_gain_rate`) | Rename a global constant with the same number of uses and a spelling that no other identifier contains | Bash (`sed -E 's/\bgain_rate\b/…/g'`)    |
| B. Target selection    | Editing a look-alike instead of the target                           | Move the definition of a function named by its signature, where the same signature also stands in a prototype above it                                | Move the definition of a function that has no prototype                                                | Tools that show every match with context |
| C. Structure           | Losing or duplicating lines when the extent of a block must be found | Move the definition of a function whose body has nested `if` and `for` blocks, so its first closing brace line is not its end                         | Move the definition of a function with a flat body                                                     | Neither by design                        |
| D. Large supplied text | Changing supplied text on the way into the file                      | Insert a supplied function of about 40 lines at a placeholder                                                                                         | Insert a supplied function of about 5 lines at a placeholder                                           | Bash (heredoc)                           |
| E. Byte exactness      | Normalizing what must stay unchanged                                 | Replace an expression on a line indented with a tab that ends in trailing spaces, next to a comment with a no-break space                             | Replace an expression on an ordinary line                                                              | Neither by design                        |

Each trap differs from its control in one factor. Within a cluster, both variants use
the same wording, so the prompt does not reveal which one is the trap.

### Instructions

All prompts use the original suite's frame: "Perform only the following mechanical file
edits…", quoted text in JSON string notation, and "Leave all text outside the requested
edits unchanged…". The cluster instructions are:

- A: `In main.cpp, replace every occurrence of the identifier "gain_rate" with "tilt_step"; there are N occurrences. Longer identifiers that contain this spelling stay unchanged.`
- B and C: `In main.cpp, move the complete definition of the function "long long f(long long value)" to the placeholder line "// __EXPLICIT_EDIT_SLOT_n_1__": the definition replaces that placeholder line. Also delete the empty line that directly followed the definition in its old place. Keep the text of the definition unchanged.`
- D: `In main.cpp, replace the placeholder line "// __EXPLICIT_EDIT_SLOT_n_1__" with the following N lines: "long long f(long long value) {\n…".`
- E: `In main.cpp, replace its one occurrence of "a * 37 + 11" with "a * 41 + 11".`

The A wording is the same for traps and controls; for a control, the last sentence
has nothing to apply to. Task ids are neutral (`edit-07`), because an agent can see
its task id in its working directory.

Constants use snake case, so a trap `gain_rate` has the look-alikes
`gain_rate_limit` and `max_gain_rate`, and a whole-word replacement such as
`sed -E 's/\bgain_rate\b/tilt_step/g'` leaves both unchanged.

### Generator constraints

- Functions without a prototype are called only from `main`, so moving them anywhere
  above `main` still compiles. Functions with a prototype can be moved freely.
- Nested blocks in C traps are deterministic integer code, such as
  `if (a % 2 == 0) { a = (a * 3 + 1) % kModulus; }` and `for (int i = 0; i < 3; ++i) { … }`.
  The generator evaluates them to predict the checksum.
- E traps put the only tabs, trailing spaces and no-break spaces of the file on their
  own lines and comments, so a tool that normalizes them elsewhere fails integrity, and
  a tool that normalizes the edited line fails the task.
- Inserted D functions are not called, so they change the text but not the checksum.
  E edits change the checksum; A, B, C and D do not.
- Moved functions contain no renamed constant and no changed expression; inserted text
  contains no renamed identifier. Every edit therefore touches text no other edit
  touches.

## Concurrency

Concurrency applies to every cluster: each run measures the same edits isolated and
shared. Its main knob is zone density, the number of agents of one wave whose edits
fall in the same function on neighbouring lines:

- Density 1: every edit of a wave is in a different function.
- Density 2, 3 and higher: that many agents edit neighbouring lines of one function at
  the same moment, for example an E edit on one line while an A rename changes the
  line below it and a C move takes the function that follows.

The generator builds one zone per group of `density` edits: a host function that
holds the zone's A uses and E sites on neighbouring lines, with the zone's moved
functions and D placeholders as the paragraphs next to it. Fillers separate zones,
and each move's destination stands in a gap of its own. The file keeps about the
same size at every density, because each host a higher density saves becomes a
filler. Tasks keep the zone order, so a wave whose size is a multiple of the density
holds whole zones.

A second knob is agents per file, which grows with the wave size. Runs sweep density
at a fixed wave size, so the robustness of a harness is a curve: how its shared result
falls below its isolated one as density grows.

So far every run had density 1. The shared mode then cost almost nothing: with exact
instructions an agent edits in one quick command, and two writes rarely overlap in
time. Higher densities target the failures that remain: rewriting a whole function
from a copy read earlier, line numbers that went stale while a neighbour edited, and
a read that lands in the middle of a neighbour's non-atomic write.

## Fairness rules

1. Every instruction has exactly one correct result for a careful reader, and the
   model-free reference reaches it by following the instruction literally with plain
   text operations. A unit test checks this for many seeds. Any harness can then solve
   every task; a low score means its agent did not, not that the task was impossible.
2. Trap and control differ in one factor, use the same wording, and come from the
   same generator, so a trap cannot be tuned to one tool without the control showing
   it.
3. The design, the generator and the grading rules are frozen before other harnesses
   are measured. Changes after a measurement start a new version, and earlier results
   stay with their version.
4. Results are reported per cluster, trap and control side by side, in both modes.

## Size

One file of 500 to 800 lines. Five clusters with two traps and two controls each give
20 edits. With one edit per task and 20 agents, a run is one wave. Composite tasks,
which list several edits in one prompt, remain available as an option.

## Evidence so far

Terra 6.1 low, seed 42, one run per configuration. Moves named only by signature, with
a prototype for every function (all moves were B traps):

| Configuration                             | Bash moves               | Pi Agent IDE moves |
| ----------------------------------------- | ------------------------ | ------------------ |
| 25 composite tasks of 4 edits, isolated   | 9 of 36                  | 35 of 36           |
| Same, shared, with the concurrency notice | 28 of 36, does not build | 35 of 36, builds   |
| Same, shared, without the notice          | 14 of 36, does not build | 36 of 36, builds   |

Bash agents matched the prototype first and cut from it to the next closing brace. The
IDE agents saw both matches and chose the definition. This is a precision result for
cluster B. It does not measure concurrency, and it has no control yet.

First runs of the cluster generator (`multi-agent-checksum-project-v5`): Terra 6.1 low,
seed 42, 20 edits, one run per cell. Each cell gives passed traps and passed controls
per cluster, 2 of each; the shared runs had 20 agents in one wave.

| Harness, mode   | Density | A        | B        | C        | D        | E        | Shared file          |
| --------------- | ------- | -------- | -------- | -------- | -------- | -------- | -------------------- |
| Bash, isolated  | 1       | 2/2, 2/2 | 0/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 |                      |
| Bash, shared    | 1       | 2/2, 2/2 | 1/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | does not build       |
| Bash, isolated  | 3       | 2/2, 2/2 | 0/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 |                      |
| Bash, shared    | 3       | 2/2, 2/2 | 0/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | does not build       |
| Bash, isolated  | 5       | 2/2, 2/2 | 0/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | 1/2, 2/2 |                      |
| Bash, shared    | 5       | 2/2, 2/2 | 0/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | does not build       |
| IDE, both modes | 1, 3, 5 | 2/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | 2/2, 2/2 | equals the reference |

The failed E trap at density 5 is a delivery in which the model returned nothing for
the whole 300-second deadline; it says nothing about the edit. With this model, only
the B trap separates the harnesses, and no density up to 5 costs either harness an
edit: every agent edits with one quick command, so two read-modify-write cycles
almost never overlap.
