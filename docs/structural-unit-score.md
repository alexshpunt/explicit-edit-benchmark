# Structural unit score

Restoring (`run-canonical`, run version `renderer-canonical-run-v2`), chunk
extraction (`chunk-run`) and two-phase assembly (`assembly-run`) measure a round
the same way. Earlier policies keep their
meaning: version 1 canonical runs use text hunks, and earlier extraction runs use
per-file or per-fragment checks. Those reports are not rescored in place.

## Units

Both protocols parse C++ with the pinned tree-sitter grammar and canonicalizer
(`canonicalCppUnits` in `grading/canonical-snapshot.mjs`). A unit is the smallest
structural scope:

- a function definition or declaration, never split;
- a class, struct or union member: method, field, nested type or other member;
- a namespace-level or global declaration;
- a preprocessor directive.

Namespaces, classes, structs, unions, linkage blocks, access sections,
conditional branches and matched `#pragma region` … `#pragma endregion` blocks
are scopes, not units. A region line without its partner stays an ordinary
directive unit. Unit version 2 added region scopes; sources without regions
produce the same units as version 1. The scope path is part of a unit's
identity, so moving a member to another class or file changes it. A unit's text
is its canonical token rendering: comments, spacing and line breaks do not count.

Functions and other sortable definitions form a multiset within their scope, so
their placement there does not count. Order-sensitive units, such as fields,
directives and variables, keep their order within the scope and are compared as
a sequence. A scope without units counts as one empty-scope unit, so an empty
file or class is still visible. Non-C++ text files are compared line by line.
Files that are not valid UTF-8 and non-regular filesystem entries count as one
unit each.

## Expected change and disagreements

The expected change of a round is the multiset of units that disappear and
appear between the trusted round start and the trusted endpoint. `N` is its
size. Moving a function counts twice: its removal from the source scope and its
appearance in the destination scope. A rename changes every unit that spells
the old name.

The actual change is computed the same way between the trusted start and the
candidate. A disagreement is a unit in the multiset symmetric difference of the
expected and actual changes. Every disagreement has weight 1, regardless of what
task produced it or which agent made the edit.

| Candidate                                  | Disagreements |
| ------------------------------------------ | ------------: |
| A function moved exactly as required       |             0 |
| A required move not done                   |             2 |
| A copy inserted, original not removed      |             1 |
| A function moved but changed               |             2 |
| An unrelated function deleted              |             1 |
| An unrelated function changed              |             2 |
| A stray `;` moved from one file to another |             2 |

Comparison never refuses a candidate. Malformed C++, invalid UTF-8, missing and
extra files are scored as units.

## Schedule

Each round allows four editing waves:

1. Original work.
2. One structural correction, only when the original capture has disagreements.
3. One build correction, only when the build fails.
4. One result correction, when the build still fails or the rendered images differ.

Every delivery has a 120-second limit, 300 seconds in two-phase assembly. A participant that exceeds it is shut
down and its partial edits remain; its assignment is not retried. Restoring then
restores the trusted round endpoint before the next round.

Structural correction assignments name each disagreeing unit in prose: the file,
the scope, whether to add or remove one copy, and the unit text. For an
order-sensitive unit, the assignment also names the unit that precedes it in the
required result. Each assignment covers one file, split into parts of at most 20
units or about 12 kB.

## Score

Structure is measured only at the original and final captures:

```text
balance = N - D0 + 0.5 * resolved - 1 * introduced
structural score = clamp(balance / N, 0, 1)
round Score = structural score * build factor * image factor
run Score = 100 * sum(round Scores) / planned rounds
```

`D0` is the number of original disagreements. `resolved` counts original
disagreements absent from the final capture, and `introduced` counts final
disagreements absent from the original capture. A disagreement present in both
is charged once. Build and image factors are 1 without a correction, 0.75 after
the allowed correction and 0.5 when the stage still fails. When the final build
fails, the image factor is 0.5.

## Commands

Extraction, from a flat case:

```sh
node scripts/module-extraction.mjs chunk-verify FLAT_CASE NEW_REFERENCE
node scripts/module-extraction.mjs chunk-smoke NEW_OUTPUT --config PRIVATE_JSON --allow-model-calls
node scripts/module-extraction.mjs chunk-run FLAT_CASE NEW_RUN --config PRIVATE_JSON --proof NEW_REFERENCE/summary.json --allow-model-calls
node scripts/module-extraction.mjs chunk-rescore FLAT_CASE SAVED_RUN NEW_OUTPUT
node scripts/module-extraction.mjs assembly-verify FLAT_CASE NEW_REFERENCE
node scripts/module-extraction.mjs assembly-run FLAT_CASE NEW_RUN --config PRIVATE_JSON --proof NEW_REFERENCE/summary.json --allow-model-calls
```

Restoring, from a canonical preparation:

```sh
node scripts/multi-agent.mjs prepare-canonical PREPARATION NEW_CACHE --proof RETAINED_PROOF --agents 15
node scripts/multi-agent.mjs verify-canonical PREPARATION NEW_REFERENCE --canonical NEW_CACHE --agents 15 --batch-size 10
node scripts/multi-agent.mjs run-canonical PREPARATION NEW_RUN --canonical NEW_CACHE --proof NEW_REFERENCE/summary.json --config PRIVATE_JSON --allow-model-calls --agents 15 --batch-size 10
```

Both reference commands are model-free and must report Score 100 from clean
committed source. The chunk reference moves every assigned fragment with ten
scripted participants. The restoring reference writes each round's trusted
endpoint during the original wave; the workload's operation-level feasibility
comes from the retained proof that preparation validates. Model runs require a
passing reference from the same commit. `chunk-rescore` recomputes a saved
extraction run from its saved original and final candidates without
participants.

Every model session receives the same general instructions,
`src/suites/explicit-edit-multi-agent/prompts/general.txt`, before its first
assignment. The file is identical for all models. Assembly sessions hold one
assignment each, so the instructions precede every assignment there.
