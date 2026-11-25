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

| Cluster                | Failure it catches                                                   | Trap                                                                                                                                    | Control                                                                                                | Likely easier for                        |
| ---------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| A. Completeness        | A missed occurrence, or an edit inside a longer identifier           | Rename a global constant with 12 to 20 uses where longer identifiers contain its spelling (`kGain` next to `kGainLimit` and `kPreGain`) | Rename a global constant with the same number of uses and a spelling that no other identifier contains | Bash (`sed -E 's/\bkGain\b/…/g'`)        |
| B. Target selection    | Editing a look-alike instead of the target                           | Move the definition of a function named by its signature, where the same signature also stands in a prototype above it                  | Move the definition of a function that has no prototype                                                | Tools that show every match with context |
| C. Structure           | Losing or duplicating lines when the extent of a block must be found | Move the definition of a function whose body has nested `if` and `for` blocks, so its first closing brace line is not its end           | Move the definition of a function with a flat body                                                     | Neither by design                        |
| D. Large supplied text | Changing supplied text on the way into the file                      | Insert a supplied function of about 40 lines at a placeholder                                                                           | Insert a supplied function of about 5 lines at a placeholder                                           | Bash (heredoc)                           |
| E. Byte exactness      | Normalizing what must stay unchanged                                 | Replace an expression on a line indented with a tab that ends in trailing spaces, next to a comment with a no-break space               | Replace an expression on an ordinary line                                                              | Neither by design                        |

Each trap differs from its control in one factor. Within a cluster, both variants use
the same wording, so the prompt does not reveal which one is the trap.

### Instructions

All prompts use the original suite's frame: "Perform only the following mechanical file
edits…", quoted text in JSON string notation, and "Leave all text outside the requested
edits unchanged…". The cluster instructions are:

- A: `In main.cpp, replace every occurrence of the identifier "kGain" with "kBoost": N occurrences. Identifiers that only contain this spelling, such as "kGainLimit", stay unchanged.`
- B and C: `In main.cpp, move the complete definition of the function "long long f(long long value)" to the placeholder line "// __EXPLICIT_EDIT_SLOT_n_1__": the definition replaces that placeholder line. Also delete the empty line that directly followed the definition in its old place. Keep the text of the definition unchanged.`
- D: `In main.cpp, replace the placeholder line "// __EXPLICIT_EDIT_SLOT_n_1__" with exactly "…".`
- E: `In main.cpp, replace its one occurrence of "a * 37 + 11" with "a * 41 + 11".`

The A wording names the look-alikes only for traps that have them; a control names
none, because it has none. This is the one place where the prompt differs between
variants, and it adds information rather than hiding a difficulty.

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

Concurrency is a mode, not a cluster. Its knob is zone density:

- Spread: edits of a wave fall in different functions.
- Packed: several agents of a wave edit neighbouring lines of the same function, for
  example an E edit on one line while an A rename changes the line below it.

So far edits were spread. The shared mode then cost almost nothing: with exact
instructions an agent edits in one quick command, and two writes rarely overlap in
time. Packed zones target the failures that remain: rewriting a whole function from a
copy read earlier, and line numbers that went stale while a neighbour edited.

## Fairness rules

1. Every trap must be solvable with plain Bash: Sol 6.2 with the Bash-only baseline
   agent passes most traps in the isolated mode. A trap that no Bash agent passes is
   removed.
2. The model-free reference follows every instruction literally with plain text
   operations and must produce each task's reference exactly. A unit test checks this
   for many seeds.
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
