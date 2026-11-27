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

Both modes give the agent the same prompt. The shared mode does not tell the agent
that other agents edit the file: avoiding collisions is the harness's job, and a
harness may warn its agent through its own prompt or tools. A sentence in the task
prompt would make every agent more careful in general, and the seventh round below
shows that it also repairs edits that have nothing to do with concurrency, so it
would mix a prompt effect into robustness. `--notice` adds that sentence for
comparison runs.

## Clusters

| Cluster             | Failure it catches                                                   | Trap                                                                                                                                                  | Control                                                                                                | Likely easier for                                                                           |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A. Completeness     | A missed occurrence, or an edit inside a longer identifier           | Rename a global constant with 12 to 20 uses where longer identifiers contain its spelling (`gain_rate` next to `gain_rate_limit` and `max_gain_rate`) | Rename a global constant with the same number of uses and a spelling that no other identifier contains | Bash (`sed -E 's/\bgain_rate\b/…/g'`)                                                       |
| B. Target selection | Editing a look-alike instead of the target                           | Move the definition of a function named by its signature, where the same signature also stands in a prototype above it                                | Move the definition of a function that has no prototype                                                | Tools that show every match with context                                                    |
| C. Structure        | Losing or duplicating lines when the extent of a block must be found | Move the definition of a function that compares a character with `'}'`, so counting braces without reading literals ends it inside its body           | Move the same kind of function comparing with `']'`                                                    | Neither by design                                                                           |
| D. Supplied text    | Changing supplied text on the way into the file                      | Insert a supplied 13-line function whose five string literals hold backslash escapes, quotes, `$HOME`, `$(date)`, backticks and `%`                   | Insert a supplied 13-line function of the same shape whose literals hold plain words                   | Neither by design: a heredoc needs a quoted delimiter, a JSON argument needs exact escaping |
| E. Byte exactness   | Normalizing what must stay unchanged                                 | Replace an expression on a line indented with a tab that ends in trailing spaces, next to a comment with a no-break space                             | Replace an expression on an ordinary line                                                              | Neither by design                                                                           |

Later rounds added clusters F to Z, then a to z, then 0 and 1. Each targets a failure
seen in a trace or a mechanism a harness could plausibly have; q to u carry failures
seen in the original suite's large renderer file over to generated code, and v to 1
carry the semantic tasks of the earlier hard pool, the assembly traps, the header
contract and the original suite's copy and cross-file families. Cluster names are
case sensitive, and the clusters after z are digits: `--clusters XYZab01` picks X, Y,
Z, a, b, 0 and 1.

| Cluster               | Trap                                                                                                                                                                            | Control                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| F. Scoped replacement | Replace an expression inside one named function while two other functions hold the same text                                                                                    | The expression stands only in that function        |
| G. Scoped rename      | Rename the local variable `b` inside one function while every function declares a `b`                                                                                           | The local variable's name is unique                |
| H. Deletion target    | Delete a function named by its signature, which also stands in a prototype                                                                                                      | The function has no prototype                      |
| I. In-place target    | Replace an expression inside a function with a prototype; the first definition after the prototypes repeats the expression                                                      | The function has no prototype                      |
| J. Overlapping pair   | Two agents at once: one moves a function, the other changes an expression inside it                                                                                             | The expression is in the function right next to it |
| K. Namespace target   | Delete the definition of `f` in the namespace `slow`, while the namespace `fast` above it defines a function with the same signature                                            | The function in `fast` has another name            |
| L. Shifted lines      | Delete a function with the comment lines above it, whose number the prompt does not give; two neighbours insert 29-line functions right above it in the same wave               | The neighbours insert right below it               |
| M. Bulk deletion      | Delete each of 32 lines, spread over the file, that call an empty trace function, and keep its definition                                                                       | Three such lines                                   |
| N. Commented copy     | Delete a function whose commented-out earlier version, with the same signature, stands in the paragraph above it                                                                | The earlier version had another name               |
| O. Raw string         | Move a function whose raw string literal holds a lone `}` line followed by an empty line                                                                                        | The literal's line is a lone `]`                   |
| P. Located by main    | Replace an expression in the function to which main passes a given number; a decoy above it holds the expression and passes the number to a library function                    | The decoy passes another number                    |
| Q. Located by callee  | Replace an expression in the only function that calls a given helper; the decoy holds the expression and a commented-out call of the helper                                     | The decoy's comment names another function         |
| R. Located by order   | Replace an expression in the definition that follows a given function's; that function has a prototype, and the lead holds the expression                                       | The function has no prototype                      |
| S. Located by use     | Replace an expression in the only function that uses a given constant; the decoy holds the expression and the constant's name in a string literal                               | The decoy's literal holds another word             |
| T. Code-only rename   | Rename a function in its prototype, definition and calls; a comment and a string literal also name it and stay unchanged                                                        | The comment and literal name another function      |
| U. Unused functions   | Delete the functions of a namespace that no code calls; the caller holds a commented-out call of one of them                                                                    | The commented-out call names a called function     |
| V. Unqualified call   | The same edit; one function of the namespace calls another without the namespace prefix                                                                                         | The call names the namespace                       |
| W. Line endings       | Delete the second of three functions from a file that main.cpp includes; the file ends its lines with CRLF                                                                      | The file ends its lines with LF                    |
| X. Byte order mark    | Delete the first of three functions from an included file that starts with a UTF-8 byte order mark                                                                              | The file has no mark                               |
| Y. End of file        | Delete the second of three functions from an included file that does not end with a newline                                                                                     | The file ends with a newline                       |
| Z. Computed edit      | Add 1000 to every number that multiplies a variable in one function; one of its four declarations writes the number before the variable                                         | Every declaration writes the variable first        |
| a. Not UTF-8          | Delete the second of three functions from an included file whose third function has a comment with a Latin-1 byte                                                               | The comment is ASCII                               |
| b. Unicode look-alike | Replace a string literal's text written in decomposed form; a decoy above it holds the composed form of the same text                                                           | The decoy holds other composed text                |
| c. Large reordering   | Put the 12 functions of a namespace in alphabetical order                                                                                                                       | Three functions                                    |
| d. Recipe tabs        | Insert a supplied make rule into a makefile beside main.cpp; its recipe lines start with a tab                                                                                  | The makefile sets `.RECIPEPREFIX = >`              |
| e. Class method       | Delete a member function of the class `Slow`, while the class `Fast` above it starts with a member function of the same signature                                               | The member function in `Fast` has another name     |
| f. Out-of-class       | Replace an expression in a member function that the class only declares, right above another member function, the lead, that holds the same expression                          | The class defines the function itself              |
| g. Nested branch      | Replace an expression in the `else if` block of an if chain inside two nested loops; the first branch holds the same expression                                                 | The first branch holds another expression          |
| h. Class end          | Delete a definition named by its first line; it is a class, which ends with `};`                                                                                                | It is a function                                   |
| i. Lambda             | Move a function with a list of weights and a lambda, both closed by `};`, and an empty line after the lambda                                                                    | No empty line                                      |
| j. Overload           | Replace an expression in the overload `f(long long, long long)`; the overload `f(long long, int)` above it holds the same expression                                            | It holds another expression                        |
| k. Constructor        | Delete the constructor `Slow(long long, long long, long long)`; a two-parameter constructor stands above it                                                                     | The class has only that constructor                |
| l. Template overload  | Delete the function template `f`; a function `long long f(long long value)` that is no template stands right above it                                                           | That function has another name                     |
| m. Override           | Replace an expression in `f` of `class Derived : public Base`; `Base` declares `virtual` `f` with the same signature and expression above it                                    | Base's `f` holds another one                       |
| n. Disabled copy      | Delete a function named by its signature; an earlier version with the same signature stands right above it inside `#if 0` and `#endif`                                          | The earlier version has another name               |
| o. Friend declaration | Replace an expression in a function; a class above it declares the function as a `friend` right above a member function that holds the same expression                          | The friend declaration names another function      |
| p. Quoted signature   | Replace an expression in a function; a comment above a decoy with the same expression quotes the function's signature                                                           | The comment quotes another signature               |
| q. Slot in a note     | Move a function to a placeholder line; a note line above every slot starts with the same placeholder text and ends with a comment                                               | The note names another slot                        |
| r. Region extraction  | Move a `#pragma region` of two functions into a new file and include that file in its place; a nested region holds the second function                                          | The region has no nested region                    |
| s. Preprocessor twin  | Move the definition of `f` that stands between `#else` and `#endif`; the `#if` branch above it holds a legacy `f` with the same signature                                       | The legacy function has another name               |
| t. Batch move order   | Move four functions to one slot in the order in which they stand in the file; the prompt lists them in alphabetical order, which differs from the file order                    | The file order is alphabetical                     |
| u. Rename by owner    | Rename a global function; a namespace holds a function of the same name and a function that calls it without the namespace, and both stay unchanged                             | The namespace's function has another name          |
| v. Overload rename    | Rename `f(long long value, long long scale)` and its two calls; the overload `f(long long value)` right above it and its two calls stay unchanged                               | The one-parameter function has another name        |
| w. Parameter swap     | Swap the two parameters of `f` and the arguments of its three calls; one call is the first argument of another, `f(f(a, 7), value)`                                             | Every argument is a plain name or number           |
| x. Field rename       | Rename the field `weight_` of the class `Slow` in its four uses; the class `Fast` above it has a field `weight_` too                                                            | The field in `Fast` has another name               |
| y. Brace in a comment | Move a function whose body holds the comment line `// The closing } of an earlier loop stood here.`                                                                             | The comment holds `]`                              |
| z. Include guard      | Move a `#ifndef`/`#define`/`#endif` guarded block of two functions into a new header that starts with `#pragma once`; an `#if` block between the functions sets a default       | The default is set without an `#if` block          |
| 0. Copy               | Copy a function's definition into an archive that `#if 0` disables, keeping the original; the function's body holds an empty line                                               | No empty line                                      |
| 1. Move between files | Move the second of three functions from one included file to a slot in another, ending its lines as that file does; the first file ends its lines with CRLF, the second with LF | Both files end their lines with LF                 |

Clusters e to m, o and x are the only places with classes, nested blocks with braces,
lambdas and templates. A class has a public section with a constructor and its
member functions, a protected helper that reads its fields, and a private section
with the fields; an x class has no helper. Every other function is a straight run of
declarations, with at most a one-line loop over the characters of a string; v and w
functions take two parameters. Clusters n, r, s, z and 0 are the only places with
preprocessor blocks, and r and z are the only edits that create a file.

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
- K: `In main.cpp, delete the complete definition of the function "long long f(long long value)" in the namespace "slow". Also delete the empty line that directly followed the definition.`
- L: `In main.cpp, delete the complete definition of the function "long long f(long long value)" together with the comment lines directly above it. Also delete the empty line that directly followed the definition.` The neighbours use the D wording.
- M: `In main.cpp, delete each line that calls the function "trace_step"; there are N lines. Keep its definition.`
- P: `In main.cpp, main passes the argument N to exactly one function. In the definition of that function, replace "a * 37 + 11" with "a * 41 + 11". The definition holds it once.` Q, R and S name the function by its callee, its neighbour or its constant in the same frame.
- T: `In main.cpp, rename the function "f" to "g": change its prototype, its definition and every call of it. Comments and string literals that mention the function stay unchanged.`
- U and V: `In main.cpp, delete the complete definition of every function in the namespace "diag" that no code calls, and the empty line that directly followed each deleted definition. Keep the namespace and the functions that are called.`
- W, X, Y and a: `In part.inc, delete the complete definition of the function "long long f(long long value)". Also delete the empty line that directly followed the definition.`
- Z: `In main.cpp, in the definition of the function "long long f(long long value)", add 1000 to every integer literal that multiplies a variable. The other numbers stay unchanged.`
- b: the E wording, with the decomposed text as it stands in the file, not as `\u` escapes.
- c: `In main.cpp, reorder the function definitions in the namespace "atlas" so that they stand in alphabetical order of their names. Keep each definition unchanged, with one empty line between definitions.`
- d: the D wording for `In rules.mk`; a trap's supplied lines hold `\t`.
- e: `In main.cpp, delete the complete definition of the member function "long long f(long long value) const" in the class "Slow". Also delete the empty line that directly followed the definition.`
- f: `In main.cpp, in the definition of the member function "long long f(long long value) const" of the class "Slow", replace "a * 37 + 11" with "a * 41 + 11". The definition holds it once.`
- g: `In main.cpp, in the definition of the function "long long f(long long value)", in the block of the branch "else if ((a + j) % 3 == 1)", replace "a * 37 + 11" with "a * 41 + 11". That block holds it once.`
- h: `In main.cpp, delete the complete definition that starts with the line "class Slow {". Also delete the empty line that directly followed the definition.` A control names a function's first line.
- i: the B wording.
- j: `In main.cpp, in the definition of the member function "f(long long, long long)" of the class "Slow", replace "a * 37 + 11" with "a * 41 + 11". The definition holds it once.`
- k: `In main.cpp, delete the complete definition of the constructor "Slow(long long, long long, long long)" of the class "Slow". Also delete the empty line that directly followed the definition.`
- l: `In main.cpp, delete the complete definition of the function template "f". Also delete the empty line that directly followed the definition.`
- m: the f wording, for the derived class.
- v: `In main.cpp, rename the function "long long f(long long value, long long scale)" to "g": change its definition and every call of it. Other functions and the calls of them stay unchanged.`
- w: `In main.cpp, swap the two parameters of the function "long long f(long long value, long long scale)", so that its first line becomes "long long f(long long scale, long long value) {", and swap the two arguments of every call of it. The body of the function stays unchanged.`
- x: `In main.cpp, rename the field "weight_" of the class "Slow" to "heft_": change its declaration and every use of it. The fields of other classes stay unchanged.`
- y: the B wording.
- z: `In main.cpp, move the block that starts with the lines "#ifndef PART_H" and "#define PART_H" into a new file part.h. The block ends with the line "#endif" that closes "#ifndef PART_H". The new file holds the line "#pragma once", an empty line and then the lines between "#define PART_H" and that closing line, unchanged, each line ending with a newline. In main.cpp, replace the block, its first two lines and its last line included, with the line "#include \"part.h\"".`
- 0: `In main.cpp, copy the complete definition of the function "long long f(long long value)" to the placeholder line "// __EXPLICIT_EDIT_SLOT_n_1__": the copy replaces that placeholder line. Keep the definition itself where it is, unchanged.`
- 1: `In old.inc, move the complete definition of the function "long long f(long long value)" to the placeholder line "// __EXPLICIT_EDIT_SLOT_n_1__" in new.inc: the definition replaces that placeholder line. Also delete the empty line that directly followed the definition in old.inc. Keep the text of the definition unchanged, and end each of its lines as the other lines of new.inc end.`

The A wording is the same for traps and controls; for a control, the last sentence
has nothing to apply to. Task ids are neutral (`edit-07`), because an agent can see
its task id in its working directory.

Constants use snake case, so a trap `gain_rate` has the look-alikes
`gain_rate_limit` and `max_gain_rate`, and a whole-word replacement such as
`sed -E 's/\bgain_rate\b/tilt_step/g'` leaves both unchanged.

### Generator constraints

- Functions without a prototype are called only from `main`, so moving them anywhere
  above `main` still compiles. Functions with a prototype can be moved freely.
- The checksum comes only from straight runs of declarations. Functions with loops,
  branches, lambdas, templates or string literals (C, O, S, T, b, g, i, l),
  functions of two parameters and their callers (v, w) and member functions (e, f,
  h, j, k, m, x) are not called, so the generator does not evaluate them.
- E traps put the only tabs, trailing spaces and no-break spaces of the file on their
  own lines and comments, so a tool that normalizes them elsewhere fails integrity, and
  a tool that normalizes the edited line fails the task.
- D literals pass through several layers: JSON escapes in the prompt, C++ escapes in
  the file, and whatever the harness adds, such as shell quoting. The literal
  `"C:\\temp\\$USER\\new"` stands in the prompt as `\"C:\\\\temp\\\\$USER\\\\new\"`.
- Inserted D functions are not called, so they change the text but not the checksum.
  E edits change the checksum; A, B, C and D do not.
- Moved functions contain no renamed constant and no changed expression; inserted text
  contains no renamed identifier. Every edit therefore touches text no other edit
  touches.

## Concurrency

Concurrency applies to every cluster. An observation of a harness and a model is two
runs of the same seed's tasks, one after the other, each with 25 agents at once:

1. The isolated run gives every task to a new agent in its own copy of the start
   project. It measures what the harness and the model get right alone.
2. The shared run gives the same tasks to a pool of 25 agents on one copy. It adds
   the crowd.

`compare` turns the two runs into the observation's score, with traps and controls
apart:

- precision: the share of edits done right alone; it measures the harness and the
  model. An edit is right alone only when its own checks pass and its task's files
  equal the reference byte for byte, with no extra files beside them, so a right
  edit that damages other text or leaves a script in the project fails;
- resilience: of the edits done right alone, the share that stay right in the
  crowd; an edit that passes only in the crowd, because another agent removed its
  wrong target first, earns nothing. In the crowd every agent changes the file, so
  an edit is checked by its own text only;
- overall: the share of edits right in both runs, precision times resilience;
- integrity: of the paragraphs that no edit changes or moves, the share that stand
  in the final shared file as in the reference. It shows damage that the other
  numbers miss, such as a script that deletes thousands of lines in which no task
  stands.

Below the score, `compare` shows each cluster's traps and controls alone and in
the crowd, and lists the edits that passed alone and failed in the crowd, and the
edits that passed only in the crowd. The shared run also reports whether the file
builds and prints the reference answer, and how many untouched paragraphs were
damaged.

Rounds up to the twenty-first recorded precision by each edit's own checks alone;
`compare` regrades their saved runs by the rule above.

Every failed edit also gets a kind, found without reading the agent's trace. An
isolated failure is judged from the start, the task's reference and the result:

- `not-done`: the files are as at the start;
- `touched-other-text`: a paragraph that the task keeps in place is lost, changed,
  duplicated or moved, as with a wrong target or a wrong cut;
- `wrong-own-text`: everything else is in place, but the task's own text differs
  from the reference, such as an escape, a line ending or a byte order mark;
- `extra-files`: the files equal the reference, but the agent left files the task
  did not ask for, such as its edit script.

A shared run reads the file after each of an agent's tool calls and on every change
of the workspace, and keeps the file as each task's agent left it. Only a task's
own agent can make its edit pass, so a version of the file on which it passes
shows a correct write:

- `own-mistake`: the edit passed on no version read while its agent worked;
- `lost-before-finish`: it passed while its agent worked and was undone before the
  agent finished;
- `lost-later`: it passed when its agent finished and a later write undid it;
- `provider-failure` and `timed-out`: the delivery was broken off.

A correct write undone before the next read counts as `own-mistake`, and an edit
that another agent's mistake made pass for a while counts as lost.

A shared run (`multi-agent-checksum-shared-v2`) is a pool of 25 agents, as in
the original Multi-Agent suite. Every agent starts and warms up before the first
task; then each takes the next task from one queue as soon as it has finished its
last one. There is no barrier, so the file keeps changing under every agent for the
whole run, and an agent keeps its session across tasks: it has to manage its own
context, compaction included, and may remember text that other agents have changed
since it read it. Only an agent whose task timed out is replaced. The edits never
touch the same text, so the reference does not depend on which agent takes which
task or in what order they finish. Version 1 instead gave every task its own agent
and started them all in one wave, which left the file quiet once the wave's quick
edits were done.

The main knob is zone density, the number of neighbouring tasks in the queue whose
edits fall in the same function on neighbouring lines:

- Density 1: every edit of a zone is in a different function.
- Density 2, 3 and higher: that many agents edit neighbouring lines of one function at
  the same moment, for example an E edit on one line while an A rename changes the
  line below it and a C move takes the function that follows.

A zone holds the edits of `density` tasks. With one edit per task, a zone has
`density` edits. With composite tasks of `edits` edits each, a zone has
`density × edits` edits and every task takes its edits from one zone, so `density`
agents work through several edits each, side by side, for longer. Composite tasks at
density 1 are the baseline for the same task size.

The generator builds one zone per group of edits: a host function that
holds the zone's A uses and E sites on neighbouring lines, with the zone's moved
functions and D placeholders as the paragraphs next to it. Fillers separate zones,
and each move's destination stands in a gap of its own. The file keeps about the
same size at every density, because each host a higher density saves becomes a
filler. Tasks keep the zone order in the queue, so the agents that take a zone's
tasks start them at about the same moment.

A second knob is the pool size, `--agents`. Runs sweep density at a fixed pool size,
so the robustness of a harness is a curve: how its shared result falls below its
isolated one as density grows.

Up to the twelfth round every shared run used version 1 with density 1, and the
shared mode then cost almost nothing: with exact
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

The file grows with the number of edits, about 20 lines per edit: the default set of
clusters B, C, F, G, H, I and J with two traps and two controls each gives 32 edits
and about 900 lines; every cluster with three traps and three controls gives 198
edits. Composite tasks, which list several edits in one prompt, remain
available as an option. The `lines` option adds longer filler functions until the
fillers alone hold that many lines, so the same edits can stand in a file of several
thousand lines: `lines` 4000 with clusters B to M gives about 5200.

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

Second round, after D traps got escaped literals and composite tasks were kept inside
one zone. Same model and seed; "5 × 4" means five composite tasks of four edits each.

| Harness | Tasks, density | Isolated: failed edits | Shared: failed edits    | Shared file                              |
| ------- | -------------- | ---------------------- | ----------------------- | ---------------------------------------- |
| Bash    | 20 × 1, 1      | both B traps           | both B traps, E control | does not build                           |
| Bash    | 5 × 4, 1       | none                   | none                    | equals the reference                     |
| Bash    | 5 × 4, 5       | none                   | none                    | equals the reference                     |
| IDE     | 20 × 1, 1      | none                   | none                    | equals the reference                     |
| IDE     | 5 × 4, 1 and 5 | none                   | none                    | builds; 2 extra blank lines at density 5 |

The escaped D literals cost neither harness an edit. The shared Bash E control failed
because a mis-cut B trap took the function that held it, so one agent's mistake broke
another agent's edit. Bash agents with four edits per task passed every B trap: each
wrote one Python script, and its pattern for a moved function was anchored on the
definition line, while single-edit agents searched for the bare signature and took
the prototype. Five agents working through four edits each in one zone cost neither
harness an edit.

Third round: clusters B, C, F and G, three traps and three controls each, 24 single
edits. F replaces an expression inside one named function while two other functions
hold the same text; G renames the local variable `b` inside one function while every
function declares a `b`; C moves a function that compares a character with `'}'`.

| Harness | Isolated: failed edits | Shared: failed edits        | Shared file          |
| ------- | ---------------------- | --------------------------- | -------------------- |
| Bash    | all 3 B traps          | all 3 B traps, one F trap\* | does not build       |
| IDE     | none                   | none                        | equals the reference |

\* The F host was the function that follows the prototypes, so a B agent moved it by
mistake while the F agent edited it.

The traces explain the pattern. A Terra Bash agent does not read `main.cpp` first: it
writes one Python script that finds the first occurrence of the quoted signature,
counts braces from the next `{`, checks that a blank line follows, and edits. F and G
pass because the signature of their function is unique, so the script scopes to the
right definition. The C trap fails the script's own check, because the brace count
stops inside the line `if (*p == '}')`; the agent then looks at the file and uses
another method that works. A B trap passes the check with the wrong text: the first
occurrence is the prototype, the next `{` opens whichever function follows the
prototypes, and that function ends cleanly, so the script moves it without any
error. A trap separates harnesses when the wrong target passes every check an agent
makes.

Fourth round: the same mechanism for two more operations. H deletes a function and I
replaces an expression inside a function; a trap's function has a prototype. The
lead function, the first definition after the prototypes, repeats every I expression,
so a script that starts from the prototype finds the expression there and edits the
wrong function without an error. Clusters B, C, F, G, H and I, two traps and two
controls each, seeds 42, 7 and 11. Collateral damage counts paragraphs that no edit
was meant to change or move but that are lost, changed or duplicated.

| Harness, mode | Failed traps over three seeds     | Failed controls | Collateral paragraphs | Shared file             |
| ------------- | --------------------------------- | --------------- | --------------------- | ----------------------- |
| Bash isolated | B 6/6, H 6/6, I 6/6; C, F, G none | none            | none                  |                         |
| Bash shared   | B 6/6, H 6/6, I 3/6, C 1/6        | none            | 2, 2, 4               | never builds            |
| IDE isolated  | none                              | none            | none                  |                         |
| IDE shared    | none                              | none            | 0, 1, 0               | builds for 2 seeds of 3 |

Every Bash failure is the silent first match. In the shared runs, some I traps pass
because an H or B agent had already removed the lead function, so the script found
nothing there and recovered; the collateral is the lead and the prototype block. The
one IDE collateral is a stale view: an agent searched for the function to delete,
another agent's edit then shifted the lines, the agent read 30 lines from the old
line number, took the body of the next function for its own and deleted from its
function's first line through the blank line after the next function. Both functions
went, and the file no longer built.

Fifth round: J pairs. One agent moves a function while another, in the same wave,
changes an expression; in a trap the expression is inside the moved function, in a
control it is in the function right next to it. Every order of the two edits gives
the same file, so a lost edit means that one agent wrote text from a copy read
before its partner's edit. Seed 42, Terra 6.1 low.

| Run                                                 | Bash                                             | IDE          |
| --------------------------------------------------- | ------------------------------------------------ | ------------ |
| Clusters B, C, F, G, H, I, J; 32 agents             | J traps 4/4, J controls 3/4 (a 300 s model hang) | all 32 edits |
| J only, 6 trap pairs and 6 control pairs; 24 agents | all 24 edits, file equals the reference          | all 24 edits |

No pair collided. Both harnesses apply an edit in one atomic step shortly after the
agent reads the text, while agents start their edits seconds apart, so two writes to
the same function never overlapped. The pairs stay in the set as a check for
harnesses that rewrite a function or a whole file from an earlier read.

Sixth round: clusters K, L and M and the size option (`multi-agent-checksum-project-v6`),
seed 42, Terra 6.1 low. A J pair counts as two edits and an L group as three.

| Run                                       | Bash, isolated        | Bash, shared                                          | IDE, both modes                      |
| ----------------------------------------- | --------------------- | ----------------------------------------------------- | ------------------------------------ |
| K, L, M; 3 traps and 3 controls; 30 edits | 2 of 3 K traps fail   | all 30 edits, file equals the reference               | all edits, file equals the reference |
| B to M; 1 trap and 1 control; 26 edits    | B, H, I traps fail    | B, H, I traps fail; 3 collateral paragraphs; no build | all edits, file equals the reference |
| Same, `lines` 4000 (5204 lines)           | B, H, I, K traps fail | B, I traps fail; 1 collateral paragraph; no build     | all edits, file equals the reference |

Over all isolated runs of this round, including the two B-to-M runs with two traps
per cluster that the last paragraph excludes for B, H and I, the Bash agents failed 6
of 9 K traps, every one by the silent first match: the script searched for the bare
signature, ignored the namespace and deleted the function in the namespace above. In
shared runs they passed all 7 K traps: with the concurrency notice
they printed the text around the match first, or anchored the search on the
namespace's opening line. The notice does not help them with B, H and I, where the
wrong match is a prototype.

L and M cost neither harness an edit. An L neighbour inserts in one call, while the
agent that deletes searches, reads and then edits, so both inserts usually land
before its read; the IDE agents also edit by content anchors, which a shift of line
numbers does not move. An IDE agent deletes all 32 M lines in one call that takes
every match of a search. A file of 5200 lines changed nothing for either harness.

The B, H and I results of two runs of this round are not counted. In the first version of M, the trace
functions' definitions stood in the prototype paragraph, so the first brace after a
B, H or I prototype was a trace function's body. The blind script then failed its own
check, the agent recovered, and those traps passed; the definitions now stand with
the constants, and a unit test checks that the first brace after such a prototype
opens the lead. One Bash agent ran out of the 300-second deadline because the model
returned nothing; it counts as a failed J control.

Seventh round, Bash only, since the IDE agents passed every edit so far
(`multi-agent-checksum-project-v7`). Two clusters aim at the blind script directly:

- N deletes a function whose commented-out earlier version stands in the paragraph
  above it. In a trap the earlier version has the same signature: the first match is
  inside the comment, its braces balance and an empty line follows it, so the script
  deletes the comment and the file still builds. A control's earlier version had
  another name.
- O moves a function that holds a raw string literal with a line of its own and an
  empty line after it. In a trap that line is a lone `}`, which both brace counting
  and the first lone `}` take for the end of the definition, and the empty line after
  it passes the script's check; the script moves half of the function. A control's
  line is a lone `]`.

Shared runs went twice, with the concurrency notice and without it (`--no-notice`).
Seeds 42, 7 and 11; trap passes summed over a run with N and O, two runs with K, N
and O, three traps and three controls each, and a run of clusters B, C and F to O
with one of each.

| Cluster | Isolated | Shared, notice | Shared, no notice |
| ------- | -------- | -------------- | ----------------- |
| K traps | 3 of 7   | 7 of 7         | 4 of 7            |
| N traps | 0 of 10  | 5 of 10        | 0 of 10           |
| O traps | 0 of 10  | 0 of 10        | 0 of 10           |

Every control passed, except one K control in a shared run that ran out of the
deadline. Every shared file failed to build, with 1 to 3 collateral paragraphs per
run with the notice and 3 to 5 without it. The notice makes the Bash agents print
the text around the match before they edit, which reveals a namespace or a comment
marker; a lone `}` inside a raw string looks like the end of the function in that
text too, so O fails in every mode. In the run with all clusters, the B, H and I
traps failed as in earlier rounds.

Eighth round, Bash only, shared runs without the notice: clusters B, C and F to O
with one trap and one control each (30 edits) in a file of about 50,000 lines
(`lines` 50000), seeds 42 and 7.

| Seed | Isolated: failed edits    | Shared: failed edits   | Collateral paragraphs | Shared file    |
| ---- | ------------------------- | ---------------------- | --------------------- | -------------- |
| 42   | B, H, I, K, N and O traps | B, I, K, N and O traps | 5                     | does not build |
| 7    | B, H, I, K, N and O traps | B, H, N and O traps    | 4                     | does not build |

Every control passed in both modes, and so did every trap of C, F, G, J, L and M.
The size made no new kind of failure. Of 75 commands in the seed-42 runs, 66 were
Python scripts that find their target by search, and only two printed the whole
file, so its length only adds a little time to each script. Next to the run of the same clusters
in a file of 930 lines (seed 42, seventh round), the only change is that K traps
failed in both modes. A shared run took 0.3 to 1.5 minutes and cost under $0.08.

Ninth round, Bash only: clusters that make the agent find its target. P, Q, R and S
replace an expression inside a function that the prompt names only by a property:

- P: main passes it a given number. A trap's decoy, a function above it, passes the
  same number to a library function.
- Q: it is the only function that calls a given helper. A trap's decoy holds the
  call in a commented-out line.
- R: it directly follows a given function's definition. A trap's anchor has a
  prototype, and the lead after the prototypes holds the same expression.
- S: it is the only function that uses a given constant. A trap's decoy holds the
  constant's name in a string literal.

The expression stands in the target and in the decoy (for R, the lead) in traps and
controls alike, so only the property tells them apart. Three traps and three controls
per cluster, seeds 42 and 7, 24 edits per run:

| Seed | Isolated | Shared                                                        |
| ---- | -------- | ------------------------------------------------------------- |
| 42   | all 24   | all 24, file equals the reference                             |
| 7    | all 24   | one Q trap fails: the decoy's expression changed; file builds |

A prompt that names the target by a property turns the blind script into a careful
one. For P the agents searched only inside `main`. For Q and S their first script
asserted that the expression occurs once, which failed loudly because it occurs
twice; they then printed the text around each occurrence and chose the right one.
The one failure was a script that took the first function around a match of the
helper's name followed by `(` that also held the expression, which was the decoy
with the commented-out call. The Bash agents fail when a prompt makes the target
look unique while it is not; when the prompt itself says that they have to look,
they look.

Tenth round, Bash only (`multi-agent-checksum-project-v8`): edits that need a reading
of the whole file. T renames a function in code only, while a trap's comment and
string literal also name it. U deletes the functions of a namespace that no code
calls, while a trap's caller holds a commented-out call of one of them. V is the
same edit, where a trap's namespace function calls another one without the
namespace prefix, so a search for the qualified name misses the call. Three traps
and three controls per cluster, seeds 42 and 7, in a file of about 900 lines and in
one of 3,000 lines (`--lines 3000`):

| Clusters | Lines | Isolated, both seeds | Shared, both seeds |
| -------- | ----- | -------------------- | ------------------ |
| T, U     | 900   | all 24               | all 24             |
| V        | 900   | all 12               | all 12             |
| T, U, V  | 3,000 | all 36               | all 36             |

None of the three traps caught a Bash agent. For T, the agents listed every line
that holds the name with `grep -n` and rewrote only the lines of code by number. For
U and V, they printed the whole file with `cat`, even at 3,000 lines, and chose the
functions to delete by reading it. As in the ninth round, a prompt that asks for a
judgment makes the agent read first.

Eleventh round, Bash only: files beside main.cpp. W and X put three functions in a
file of their own that main.cpp includes (`#include "part.inc"`). The first version
replaced an expression in such a file; every edit passed, because the agents'
scripts for a single replacement read and wrote bytes. The second version deletes a
function, an edit whose scripts had read text in earlier rounds:

| Seed | Isolated | Shared                                                     |
| ---- | -------- | ---------------------------------------------------------- |
| 42   | all 12   | one X trap fails: the byte order mark is gone; file builds |
| 7    | all 12   | one X trap fails the same way                              |

No W trap failed. The agents opened the included files in binary mode or with
`newline=""` from their first script, and one script detected the line ending
before it deleted the definition. Both X failures came from the same script: it took
the start of the function's line as the position after the last newline before the
signature, which is 0 when the function is the first in the file, and so deleted
the byte order mark with the definition. The file still builds and prints the
reference answer, so only the byte comparison sees the damage.

Twelfth round, Bash only (`multi-agent-checksum-project-v9`): new axes. Y, Z, a, b,
c and d, three traps and three controls each, seeds 42 and 7. Files beside main.cpp
are byte strings from this version on: the runners read and write them as Latin-1,
one character per byte, so a byte that is not UTF-8 survives and the grade
compares bytes.

| Cluster | Isolated, both seeds | Shared, both seeds |
| ------- | -------------------- | ------------------ |
| Y       | all 12               | all 12             |
| Z       | all 12               | all 12             |
| a       | all 12               | all 12             |
| b       | all 12               | all 12             |
| c       | all 12               | all 12             |
| d       | all 12               | all 12             |

The first version of Y deleted the last function of a file without a final
newline, and every Y trap failed: the agents deleted whole lines, so the line
before kept its newline, while the reference also dropped that newline. Both
readings of the instruction are fair, so those results are not counted, and Y now
deletes the middle function, which leaves the file's end unambiguous. The table
shows the second version.

None of the new traps caught a Bash agent. Their scripts read and wrote bytes from
the first command, so a missing final newline, a Latin-1 byte and a tab passed
through unchanged; for d they wrote the tab as `\t` in a Python bytes literal. For
b they copied the decomposed text from the prompt code point for code point, in
one script even as `"u\u0308ber mode"`, and asserted that it occurs once. For Z
they printed the function first and replaced each product by its exact text,
including the one written number first. For c they cut the namespace's body into
definitions and sorted them in one script.

Thirteenth round, Bash only: the first shared runs as a pool
(`multi-agent-checksum-shared-v2`). Every cluster, three traps and three controls
each, 198 tasks, seeds 42 and 7; isolated runs with six agents at a time, shared
runs with 25 agents on one queue. Each pool agent did 7 to 10 tasks in one session;
none of them reached a context compaction. Passed tasks, with the grade described
below:

| Seed | Isolated | Shared pool | Shared file                              |
| ---- | -------- | ----------- | ---------------------------------------- |
| 42   | 178      | 184         | does not build; 11 damaged, 5 collateral |
| 7    | 182      | 184         | does not build; 11 damaged, 3 collateral |

Isolated runs failed only the B, H, I, K, N and O traps and two X traps, as in
earlier rounds. The pool passes more tasks, because some blind scripts in it found
their wrong target already removed by another agent and recovered: every I trap
passed in both pool runs. It also adds failures that no isolated run and no
single-wave run had:

- Lost updates. A T control's agent renamed the function with a script that read
  the whole file, replaced every occurrence and wrote it back; another agent's
  script, which had read the file earlier, wrote its copy over it, and only one
  renamed call survived. An L control's inserted function vanished from the file
  the same way.
- Supplied text late in a session. Two D traps failed in the fifth and the eighth
  task of their agent: one script wrote a real tab where the literal holds `\t`,
  the other dropped a backslash. No D trap failed in a fresh session.
- One W trap in the agent's first task, written back in text mode, and one T trap
  that renamed the function inside its string literal.

In the first grade of these runs, T renames, A renames and inserts also failed for
text that another agent's blind cut had destroyed: a B or H trap's script cut from
its prototype through the end of the lead and took the prototypes of T functions
with it. The grade now leaves such damage to the collateral count: a T rename
checks each line of code that names the function and skips a line that is gone, an
A rename checks that no old name stays and no look-alike is renamed, and an insert
glued to the paragraph above it passes when the paragraph below it is the reference
one. The table shows this grade; the first one gave 179 and 180 shared passes.

Fourteenth round, Bash only: the first observations with the score. Seed 42, every
cluster, three traps and three controls each, 198 edits; an isolated run and then
a pool, 25 agents each.

| Model, thinking | Precision | Resilience | Overall | Collateral paragraphs |
| --------------- | --------- | ---------- | ------- | --------------------- |
| Terra 6.1, low  | 90.9%     | 94.4%      | 85.9%   | 4                     |
| Luna 6, high    | 96.0%     | 93.7%      | 89.9%   | 10                    |

On traps alone, Terra passed 81.8% and Luna 94.9%. Terra failed every B, H, I, K, N
and O trap alone, each as `touched-other-text`; Luna passed all of them. Luna's
eight failures alone were two W traps and an X trap written back with changed line
endings or without the byte order mark, a D trap with a changed escape, a T trap
that renamed inside a literal, and three controls: a move that left a copy of the
function behind, a reordering that lost an empty line, and a makefile rule whose
recipes got tabs although the file sets `>` as the recipe prefix. In the crowd the
two models lost about as much: 10 edits for Terra and 12 for Luna, most of them
`own-mistake`.

Fifteenth round: the same observations in a compact file (`--compact`), where the
units of all clusters stand side by side and only the fillers that the library,
the constant uses and the F decoys need remain: 4,487 lines instead of 7,254.

| Model, thinking | Layout  | Precision | Resilience | Overall | Collateral paragraphs |
| --------------- | ------- | --------- | ---------- | ------- | --------------------- |
| Terra 6.1, low  | spread  | 90.9%     | 94.4%      | 85.9%   | 4                     |
| Terra 6.1, low  | compact | 91.4%     | 98.9%      | 90.4%   | 5                     |
| Luna 6, high    | spread  | 96.0%     | 93.7%      | 89.9%   | 10                    |
| Luna 6, high    | compact | 97.5%     | 95.9%      | 93.4%   | 5                     |

Packing the edits side by side cost neither model anything in the crowd; both lost
fewer edits than in the spread file, which is within the run-to-run spread of the
pool. Each agent edits with a script that finds its text by content and writes the
file in one step, so the distance between two agents' edits does not matter; what
matters is whether two read-modify-write cycles overlap in time, and with one
command per edit they rarely do.

The first compact isolated run of Terra lost 63 tasks to the provider's false
usage-limit error, all within five seconds, and every retry started right away and
failed the same way. Retries now wait a minute, then two; the table shows the run
after that change.

Sixteenth round: clusters e to i, the first with classes, nested blocks with braces
and lambdas, added to the compact file of every cluster: 228 edits.

| Model, thinking | Precision | Resilience | Overall | Collateral paragraphs |
| --------------- | --------- | ---------- | ------- | --------------------- |
| Terra 6.1, low  | 90.8%     | 97.6%      | 88.6%   | 10                    |
| Luna 6, high    | 96.1%     | 94.5%      | 90.8%   | 6                     |

| Cluster | Terra alone: traps, controls | Terra crowd | Luna alone | Luna crowd |
| ------- | ---------------------------- | ----------- | ---------- | ---------- |
| e       | 0/3, 3/3                     | 2/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |
| f       | 0/3, 3/3                     | 1/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |
| g       | 3/3, 3/3                     | 3/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |
| h       | 3/3, 3/3                     | 3/3, 3/3    | 2/3, 3/3   | 1/3, 3/3   |
| i       | 3/3, 3/3                     | 3/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |

Terra's isolated agents failed every e and f trap: they deleted the other class's
member function, or edited the lead behind the declaration, the same first-match
habit as in B, H, I and K. Luna passed them, but three of its h scripts cut the
class at the brace that closes it, one of them with a comment that says it
includes the semicolon, and left a lone `;`. g and i caught neither model: both read
the branch condition and moved the lambda's function whole.

The first grade of the Luna crowd failed all six h edits: a lone semicolon failed
every h edit, controls included. A semicolon now fails only the deletion whose
definition stood between the same paragraphs; the table shows the grade after that
change. The two h traps lost in the crowd were labelled `lost-before-finish`, but
their agents' scripts left the semicolon in their only write. The run had read
main.cpp right after a Python script truncated it and before it wrote the file
back, and every deletion passes on an empty file. A shared run now skips a read
unless the file still ends with main.

Seventeenth round: classes with sections, fields and constructors, and clusters j
to m, in the compact file of every cluster: 252 edits.

| Model, thinking | Precision | Resilience | Overall |
| --------------- | --------- | ---------- | ------- |
| Terra 6.1, low  | 90.5%     | 98.2%      | 88.9%   |
| Luna 6, high    | 97.6%     | 94.7%      | 92.5%   |

| Cluster | Terra alone: traps, controls | Terra crowd | Luna alone | Luna crowd |
| ------- | ---------------------------- | ----------- | ---------- | ---------- |
| e       | 1/3, 3/3                     | 3/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |
| f       | 1/3, 2/3                     | 1/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |
| j       | 3/3, 3/3                     | 3/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |
| k       | 3/3, 3/3                     | 3/3, 3/3    | 3/3, 3/3   | 2/3, 3/3   |
| l       | 3/3, 3/3                     | 3/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |
| m       | 1/3, 3/3                     | 3/3, 3/3    | 3/3, 3/3   | 3/3, 3/3   |

j, k and l caught neither model. Terra's scripts print the definition first and
then replace its exact text after asserting that it stands once: a k trap's brace
initializers and an l trap's parameter line are part of the printed text, and a j
trap's first replacement stopped at the assertion, because the expression stands
twice, before the script was narrowed to the four-parameter overload. These traps
fail loudly or are visible in what the agent reads; the ones that catch Terra, e,
f and m, are silent: the first match is a valid edit of the wrong function.

Version 12 of the project makes j, k and l silent in the same way. A j trap's
decoy is the overload `f(long long, int)` above the target `f(long long, long
long)`, a k trap's is a two-parameter constructor above the target, and an l
trap's is a function of the same name, which is no template, right above the
template. In each, the first definition of the name is a valid edit of the wrong
function. The brace initializers of k and the template line of l as written in
the seventeenth round caught nobody and are gone.

Eighteenth round: the silent j, k and l with m, three traps and three controls
each, in a compact file of these clusters alone. Both models passed every edit
alone; in the crowd Terra lost a j and an m trap and Luna an m trap, all as
`own-mistake`. Terra's scripts first print the region around the name with
`grep -C` or `grep -A 25 -B 5`, which shows both overloads, both constructors or
both functions, and then replace or delete the exact text they read. A replacement
across the file stops at its own `assert s.count(old) == 1` when the expression
also stands in the decoy. A decoy that the agent's first read shows does not catch
it; the traps that did, B, H, I, N and O, put the decoy where the first read
misleads: a prototype before the definition, a commented-out copy, or a brace in a
literal.

Nineteenth round, version 13 with clusters n, o and p, seed 42, three traps and
three controls each. In a compact file of these clusters alone, Terra failed 8 of
9 traps alone and passed every control; Luna passed every edit. Terra's scripts
find the signature with `s.index(...)` and take the first brace after it, or the
first match of the expression after it: the disabled copy, the friend declaration
and the quoted signature all come first. In the crowd run of all 42 clusters,
every task holds three edits (`--edits 3`), 270 edits in all:

| Model | Precision | Resilience | Overall | n, o, p traps alone |
| ----- | --------- | ---------- | ------- | ------------------- |
| Terra | 89.3%     | 99.2%      | 88.5%   | 3/3, 0/3, 0/3       |
| Luna  | 97.8%     | 93.9%      | 91.9%   | 3/3, 3/3, 3/3       |

Resilience barely moved from the seventeenth round, where every task held one
edit: 98.2% for Terra and 94.7% for Luna. Three edits per task do not make the
crowd measurably harder. Luna's losses in the crowd are spread over 16 clusters,
almost all `own-mistake`. The crowd run cost $2.22 for Terra and $0.33 for Luna,
the run of n, o and p $0.08 and $0.02, both modes included.

Twentieth round, version 14 with clusters q to u, seed 42, three traps and three
controls each, in a compact file of these clusters alone. These clusters carry
failures from the original suite's renderer file over to generated code:

| Model | Precision | Resilience | Overall | Traps alone (q, r, s, t, u) | Traps in the crowd |
| ----- | --------- | ---------- | ------- | --------------------------- | ------------------ |
| Terra | 96.7%     | 96.6%      | 93.3%   | 3, 3, 2, 3, 3 of 3          | 3, 3, 2, 3, 3 of 3 |
| Luna  | 83.3%     | 76.0%      | 63.3%   | 2, 0, 3, 3, 2 of 3          | 3, 0, 1, 1, 3 of 3 |

Every control passed alone. The roles of the two models turned around: Terra lost
only one trap alone, while Luna lost five, each without a word. Luna cut every r
region at the first `#pragma endregion` after its first line, which closes the
nested region, so the new file lacks its last line and main.cpp keeps a stray
`#pragma endregion`; both still build. Two q scripts stopped at their own
`assert s.count(slot) == 1` and retried with the slot's whole line. One of them
checked that the whole line stands once and then replaced the first match of the
slot's text, which is the note. One u script replaced every match of the name
without reading the file, the namespace's function and its call included. Terra's s
failure searched for the signature after the first `#else` of the file, which
belongs to another block, so it moved the legacy twin and the program no longer
builds.

In the crowd, Luna moved one t trap's functions in the prompt's alphabetical order
and wrote two r controls' include lines without a newline of their own, which
removes the empty line after them. Luna's shared file did not build at the end.
Terra lost one more s trap in the crowd. The run cost $0.31 for Terra and $0.08 for Luna, both
modes included.

Twenty-first round, version 15 with clusters v to z, 0 and 1, seed 42, three traps
and three controls each, in a compact file of these clusters alone. They carry over
the semantic tasks of the earlier hard pool, an assembly trap, the header contract
and the original suite's copy and cross-file families:

| Model | Precision | Resilience | Overall | Traps alone (v, w, x, y, z, 0, 1) | Traps in the crowd  |
| ----- | --------- | ---------- | ------- | --------------------------------- | ------------------- |
| Terra | 92.9%     | 100.0%     | 92.9%   | 0, 3, 3, 3, 3, 3, 3 of 3          | 0, 3, 3, 3, 3, 3, 3 |
| Luna  | 76.2%     | 87.5%      | 66.7%   | 0, 2, 3, 2, 1, 3, 2 of 3          | 1, 3, 3, 2, 0, 2, 2 |

Both models renamed every v overload: each wrote one replacement of the name
without reading the file, which also renames the function of one parameter and its
calls, and the file still builds. One Luna w script swapped the arguments of the
inner call of `f(f(a, 7), value)` and left the outer call as it was. Luna wrote one
1 source file back in text mode, which turned its CRLF line endings into LF. The z
failures were Luna's alone, in traps and controls: one header kept the guard's
`#define` line, one header and main.cpp moved an empty line across the boundary, one
trap closed the block at the inner `#endif` and moved the closing `#endif` to the end
of the header, and one header ended with an extra `#endif` and does not build. The
y trap that Luna failed alone replaced the slot before it deleted the old text, so
its deletion of the first match removed the new copy. Alone, no agent was caught by
the brace in the y comment or by the empty line in a 0 definition, and no x rename
touched the other class.

A second run used a non-compact file of 6,000 lines with clusters B, H, N, O, T and
c, three traps and three controls each:

| Model | Precision | Resilience | Overall | Traps alone (B, H, N, O, T, c) |
| ----- | --------- | ---------- | ------- | ------------------------------ |
| Terra | 69.4%     | 88.0%      | 61.1%   | 0, 1, 0, 0, 3, 3 of 3          |
| Luna  | 94.4%     | 88.2%      | 83.3%   | 3, 3, 3, 3, 3, 1 of 3          |

Terra failed the B, H, N and O traps as in the earlier rounds; in the two traces
checked, a single script took the first match of the signature and counted braces
without reading the file first. Luna lost two of the three c traps alone. Pi's Bash
tool keeps the last 2,000 lines or 50 KB of an output. Terra got a cut output in
five of its 36 tasks, all of them c tasks, and Luna in four, three B tasks and a c
task; none of the tasks that failed alone had a cut output. Both shared files of the large run failed to build at
the end. The compact run cost $0.31 for Terra and $0.06 for Luna, the large run
$0.43 and $0.07, both modes included.

A third run used the same clusters in a file of 54,287 lines:

| Model | Precision | Resilience | Overall | Traps alone (B, H, N, O, T, c) | Traps in the crowd |
| ----- | --------- | ---------- | ------- | ------------------------------ | ------------------ |
| Terra | 66.7%     | 75.0%      | 50.0%   | 0, 0, 0, 0, 3, 3 of 3          | 0, 0, 0, 0, 0, 3   |
| Luna  | 97.2%     | 74.3%      | 72.2%   | 3, 3, 3, 3, 3, 2 of 3          | 2, 3, 1, 3, 3, 1   |

Alone, the size changed little against 6,000 lines. Terra's cut outputs came from
the same five c tasks; Luna's from three c tasks, one of them the c trap it failed. In the crowd, Luna's final file had 44,707 lines and lost 625 paragraphs
that no edit touches. One O trap's agent had printed the whole file, got its last
2,000 lines, and then moved the function by the first lone `}` line, which is in the
raw string. Its repair script wrote the whole function at the slot and then deleted
from the first match of a line of the literal to the next function after the old
place. That first match was the repaired copy at the slot, so the deletion removed
the 9,500 lines between the slot and the old place; the rest of the run kept the cut.
In a large file a slot and its function stand far apart, so one wrong anchor removes
thousands of lines. Terra lost every T trap in the crowd: its renames rewrote the
whole file of 2.3 MB with a byte-by-byte Python lexer, and the rename did not
survive until the check after its own write. The run cost $0.50 for Terra and $0.08
for Luna, both modes included.

Graded again with exact files alone and with integrity, only Luna's 54,287-line
run changes: two O traps whose own checks passed alone left damage elsewhere in the
file, so its precision falls to 91.7%, resilience is 72.7% and overall 66.7%.
Integrity, the share of untouched paragraphs intact in the crowd:

| Run          | Terra               | Luna                |
| ------------ | ------------------- | ------------------- |
| Compact      | 96.6% (86/89)       | 93.3% (83/89)       |
| 6,000 lines  | 99.0% (516/521)     | 99.0% (516/521)     |
| 54,287 lines | 99.8% (3,282/3,287) | 81.0% (2,662/3,287) |
