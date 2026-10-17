# Share a result

Run a registered suite with your own model and Hugging Face account. You never
need a maintainer token. Choose the suite and local/official mode in the
[README](../README.md#run-and-publish). This guide covers ordinary local contributions;
[official community runs](official-community-runs.md) explains verified evidence.

## What the common command does

| Phase           | What happens                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configure       | Resolve the selected suite and harness/model profiles; check installed binary, version and public identity                                                            |
| Account check   | Confirm Hugging Face access before spending model credit                                                                                                              |
| Smoke           | Call the model on one exact auth/tool smoke task per configuration; stop if any configuration fails                                                                   |
| Prepare and run | Apply the selected suite's workload, reference prerequisites and run policy                                                                                           |
| Submit          | Export and validate the common safe bundle, build safe metadata and open a [Dataset](https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark) contribution |

Original Explicit Edit runs 226 independent tasks. Its submit defaults are five
Oracle recoveries, concurrency 10 and a 120-second delivery timeout. Supported
overrides are recorded and compared under their matching policy.

Multi-Agent runs all 71 scoring groups with a fixed 15-agent team. Participants
receive individual ready edits, not entire groups. Model-free preparation and a
matching atomic-stream reference proof precede measured execution. It allows
five retained-state corrections after the initial barrier attempt and has no
local overall or delivery deadline. Score weights first-pass success at 75% and
eventual success at 25% over the same 71 groups, not the atomic delivery count.
It accepts no scored task subset or smaller team. Read the
[run guide](multi-agent.md) for verification levels, compiler requirements and costs.

The automatic smoke is a model/auth check, not proof that a model can solve the
selected suite. It can lead directly into the full paid run, so approve both
execution and submission first. Do not add a second smoke or set `ready: true`
to bypass the gate; readiness applies to the lower-level `raw-run` route.

## Your responsibilities

- Keep every failed task, timeout, correction and legitimate early stop.
- Do not reset state or rerun only failures to improve the recorded observation.
- Never edit exported rows to improve a result. Fix identity/configuration at its source.
- Send the run ID and Dataset contribution URL to the maintainers.
- Keep raw reports, workspaces, configs and credentials private.

The [public-data section](../README.md#what-gets-published) describes what leaves
the machine. Both suites export the same five safe tables. Multi-Agent adds
task/barrier/participant links, not a second result store. Missing native metrics
remain unknown.

## Acceptance and delivery

Ordinary local candidates are `unverified`. Approved GitHub workflow results
become `verified` after proof validation. Both use automatic structural admission;
Score never controls acceptance. Code, adapter, task, policy and workflow changes
still need pull-request review.

Scheduled acceptance appends retained evidence and table shards, updates compact
views in one parent-checked Dataset commit, posts a receipt and closes the candidate.
It does not use the Hub merge action or rebuild all history on every contribution.

Submitted is not accepted. Check the receipt before reporting publication success.
A temporary delivery failure is not a reason to repeat model calls. Official
submit-only recovery reuses the original run ID, attempt, signer and signed
archive. An unknown upload result needs investigation before retrying, so it does
not create duplicate candidates.

See [benchmark automation](benchmark-automation.md) for storage/validation and
[official recovery](official-community-runs.md#operations-and-recovery) for operator steps.
