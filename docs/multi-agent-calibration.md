# Multi-Agent calibration

These are observed calibration trials, not accepted Dataset entries or a stable
model ranking. All used the complete 71-task workload, a shared source tree and
15 persistent Baseline Agents. Default execution had 28 ready-task barriers,
rotating ownership, no overall or attempt deadline, and three coarse corrections
per barrier.

| Model route                              | Reasoning | Accepted tasks | Completion | Wall time | Terminal         |
| ---------------------------------------- | --------- | -------------: | ---------: | --------: | ---------------- |
| `openai-codex/gpt-6.1-sol`               | high      |          71/71 |       100% | 67.76 min | pass             |
| `openai-codex/gpt-6.1-sol`               | low       |          16/71 |     22.54% |  9.72 min | blocked, round 4 |
| `opencode-go/muse-spark-1.3-contributor` | high      |          22/71 |     30.99% | 75.88 min | blocked, round 5 |
| `openai-codex/gpt-6-luna`                | high      |           3/71 |      4.23% | 10.22 min | blocked, round 2 |

The Sol and Muse trials used the same participant-disclosure guidance. The Luna
trial used the corrected parallel graph but predates explicit team/round notices;
it is labelled here as an earlier guidance variant, not an identical comparison.
OpenCode Go supplied Muse's model; the agent runtime was Pi, not OpenCode CLI.
Usage and cost were not completely observed in these trials and remain unknown.

Sol high had one correction delivery. Sol low had 18, Muse had 27 and Luna had 18.
Those are agent correction blocks, not the number of failed rounds. All agent
processes were closed after each trial. There were no automatic restarts.

An earlier single-agent Sol 6.1 high run passed all 71 coherent goals in about
10.47 hours. The shared-team run completed in about 68 minutes. This observed
wall-time reduction is useful operationally; it is not a general speedup guarantee
or a claim about total compute or model cost.

## Why the failed prefixes count as editing failures

The stopped trials were audited separately without new model calls. Original
reports and saved attempts were not changed or rescored.

- **Sol low:** all four terminal attempts failed independent fresh Clang builds.
  Replaying the recorded extraction on the last accepted source without peers
  reproduced the damaged main file. A correct execution of the same public task
  passed the structural obligations, build and repeated renders.
- **Muse:** the seven failed saved states, including the recovered preceding
  barrier, compiled and rendered correctly but retained or reverted required
  names. Applying only 206 remaining public owner-bound rename occurrences to a
  private copy of the terminal candidate made the unchanged checker pass all
  2,782 obligations, fresh compilation and repeated renders. The audit did not
  substitute expected source or waive exact names.
- **Luna:** the terminal attempts had invalid preprocessor boundaries. Independent
  compiler checks failed. Its first correct noise extraction passed the editing
  obligations and repeated renders; later recorded commands reproduced invalid
  guards without needing another concurrent writer.

The audit also checked complete task-table delivery, passing Sol high controls
and a permitted reopened-namespace alternative. No benchmark defect explaining
these stops was found. Parser-error cascades are not evidence of thousands of
lost peer updates. Exact live interleavings and lost-update attribution remain
unknown.

## Evidence identities

Private raw reports are retained outside Git. These hashes identify the audited
report bytes; a hash alone does not make private evidence publicly reproducible.

| Trial                       | Original report SHA256                                             |
| --------------------------- | ------------------------------------------------------------------ |
| Sol high                    | `df2a8c2ffc1008c29e074da9385c8c65604d575ae5cfba37b12867801676471a` |
| Sol low                     | `f49d506d941eed4168f57901d883078f77dbbbcc17d1636cc0cd1fe4a35a7f89` |
| Muse high                   | `59d9e0f1d2aba3eb3a109ec92f5a284de995636ae4f60b1fa50b75e9b2f590d0` |
| Luna high, earlier guidance | `a1c9c204a317ff708dac799bb2c2928a4435503afd5fef35a4f08bc93fe59111` |

The default 15-agent, explicit 14-agent and single-agent scripted routes have
passed the full restoration checks. Scripted proof establishes solvability under
the chosen schedule; the full live Sol pass establishes that a model agent team
can complete it too. Repeated model trials would measure variability, which these
single calibration observations do not estimate.
