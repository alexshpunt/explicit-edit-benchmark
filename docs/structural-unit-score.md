# Line difference score

Restoring (`run-canonical`, run version `renderer-canonical-run-v3`) and two-phase
assembly (`assembly-run`, run version `renderer-assembly-run-v2`) measure a round
by line differences against the trusted endpoint. Earlier policies keep their
meaning and are not rescored in place: version 2 canonical runs, version 1
assembly runs and chunk runs counted structural units (described at the end of
this page), version 1 canonical runs used text hunks, and earlier extraction runs
used per-file or per-fragment checks.

## Lines

Assignments ask for exact edits, so the measure is the text itself, not its
syntax. Each file is compared as a sequence of lines after removing spaces at the
end of each line and ignoring blank lines. Everything else counts, including
indentation, comments and order. `grading/line-differences.mjs` diffs every file
of the candidate against the endpoint with the Myers algorithm.

A difference is one line that is missing where the endpoint has it, or one extra
line the endpoint does not have. Every difference has weight 1, so losing a large
block costs more than losing a small one. A file's presence counts as one line,
so a missing or extra file also costs its presence. A file that is not valid
UTF-8 counts as one line describing its bytes, and a non-regular filesystem
entry as one difference.

`N` is the line difference between the trusted round start and the endpoint.
Moving a line costs two: its removal and its insertion. Because the diff is
minimal, a block moved past fewer lines than it holds costs the lines it crossed
instead.

| Candidate                                          | Differences |
| -------------------------------------------------- | ----------: |
| A 10-line function moved exactly as required       |           0 |
| The same move not done                             |          20 |
| A copy inserted, original not removed              |          10 |
| One line of the function changed after the move    |           2 |
| A struct cut short, its last two lines left behind |           4 |
| A helper script left in the workspace (5 lines)    |           6 |

A broken brace therefore costs the lines that actually differ; syntax errors do
not spread to the rest of the file. Comparison never refuses a candidate.

## Schedule

Each round allows four editing waves:

1. Original work.
2. One structural correction, only when the original capture has disagreements.
3. One build correction, only when the build fails.
4. One result correction, when the build still fails or the rendered images differ.

Every delivery has a 120-second limit, 300 seconds in two-phase assembly. A participant that exceeds it is shut
down and its partial edits remain; its assignment is not retried. Restoring then
restores the trusted round endpoint before the next round.

Structural correction assignments describe each changed hunk in prose: up to
three lines before it and the line after it in the current file, an approximate
line number at the time of the check, and the lines to remove and to add, in code
blocks. A missing file is created with its complete lines, and an extra file is
deleted. Each assignment covers one file, split into parts of at most 20 hunks or
about 12 kB; one hunk is never split.

## Score

Differences are measured only at the original and final captures:

```text
balance = N - D0 + 0.25 * resolved - 1 * introduced
structural score = clamp(balance / N, 0, 1)
round Score = structural score * build factor * image factor
run Score = 100 * sum(round Scores) / planned rounds
```

`D0` is the number of original line differences; a disagreement below means one
line difference. `resolved` counts original
disagreements absent from the final capture, and `introduced` counts final
disagreements absent from the original capture. A disagreement present in both
is charged once. As in the main suite, where quality is 0.75 × first exact +
0.25 × final exact, a resolved original difference refunds a quarter of its cost;
a difference introduced later costs as much as an original one. Line difference
score version 1 refunded half, as chunk runs still do. Build and image factors are 1 without a correction, 0.75 after
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

## Earlier structural unit policy

Version 2 canonical runs, version 1 assembly runs and chunk runs parsed C++ with
the pinned tree-sitter grammar (`canonicalCppUnits` in
`grading/canonical-snapshot.mjs`) and counted units: functions, class members,
declarations and directives inside namespace, class, conditional and region
scopes. A disagreement was a unit in the symmetric difference of the expected and
actual unit changes. The policy was replaced because one missing brace makes
every later unit parse inside the broken scope: in one Sol 6.1 low assembly probe,
a struct cut short produced about 4260 of 4578 disagreements. Chunk commands
still use this policy.
