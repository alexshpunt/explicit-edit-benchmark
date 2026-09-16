---
name: review-benchmark-candidate
description: Review a benchmark pull request, validate it, and accept or merge it only after the user confirms. Use when reviewing a Hugging Face Dataset candidate opened by a contributor, or a code pull request to this repository.
compatibility: Linux, Node.js 24+, an authenticated Hugging Face login or HF_TOKEN, and this repository's installed dependencies.
---

# Review a benchmark pull request

## Recognise what you are reviewing

- **Ordinary result candidate** — a Hugging Face Dataset pull request containing one normalized `candidates/<run-id>/` directory. It is unverified and follows the manual review below.
- **Official result candidate** — a Dataset pull request under `candidates/official/<executionId>/` containing the signed archive, attestation, and transport metadata. Repository automation verifies and accepts it by policy; do not manually approve or reject it based on score.
- **Code pull request** — a pull request on this GitHub repository: adapters, tasks, docs, or tooling. Merging it changes the benchmark itself.

Never manually accept an ordinary candidate or merge code before the user confirms. Official result candidates are handled by automatic policy and do not need a human score review.

## Read it

For a candidate, download the pull request revision first:

```sh
hf download alexshpunt/explicit-edit-benchmark --repo-type dataset \
  --revision refs/pr/PR_NUMBER --local-dir .tmp/candidate
```

Read, in this order: `candidates/<run-id>/submission.json` (who sent it, purpose), `manifest.json` (contract, task-set hash, counts, policy), `profiles.jsonl` (agent, model, provider, harness, exact versions, reasoning), and skim `trials.jsonl` for the first and final exact results.

For a code pull request, read the diff and the touched files. Read `docs/benchmark-automation.md` when the change touches the schema, the aggregation, or the Dataset views.

## Validate

For a candidate, run the full acceptance path without publishing anything:

```sh
npm run benchmark -- accept --repository alexshpunt/explicit-edit-benchmark \
  --candidate PR_NUMBER --dry-run
```

This downloads current `main` and the candidate revision, runs the normalized validator and the strict ingestion validator, appends the candidate to a temporary store, rebuilds every generated view, and fails if an accepted observation would be dropped or rewritten. It ends with `Validated …; dry run, nothing published` and makes no commit. Confirm the dataset head has not moved afterwards.

Also check by hand, because these are judgement calls:

- the purpose field matches what the run actually is;
- the `clientRunId` and run id are new, and one pull request carries one run;
- the task-set hash equals the task set of this repository (`npm run bench:list` gives the tasks);
- identities are complete and truthful: agent, model, provider, harness, exact versions, reasoning;
- failures and timeouts are still in the result, not replaced by retries that only succeeded;
- no credentials, machine paths, prompts, raw commands, or command output anywhere in the bundle;
- the tools the run used match the harness it claims: compare `tool-calls.jsonl` with the harness's own tools, because a misconfigured extension silently falls back to the agent's built-in tools and still passes every task.

For a code pull request, run:

```sh
npm run check
```

When the diff adds a harness adapter, also apply the checks in `add-benchmark-harness`.

## Report before you ask

Tell the user what you found, in plain words: the kind of pull request, who sent it, the claimed identity, how many trials and tasks it covers, the first and final exact rates, what the dry run reported, and anything unverifiable or wrong. Quote the commands you ran so the claims can be rechecked.

## Ask, then apply the decision

Ask the user with the ask tool before any write, and offer three outcomes: accept or merge, request changes, reject. Keep the question short and do not bundle it with unrelated questions. Do not skip it because validation passed, and do not merge on your own initiative.

- **Accept a candidate**: `npm run benchmark -- accept --repository alexshpunt/explicit-edit-benchmark --candidate PR_NUMBER`. Report the accepted Dataset commit.
- **Merge a code pull request**: merge in GitHub once CI is green. Report the merge commit.
- **Request changes**: write the review comment with the exact failing evidence.
- **Reject**: explain why and leave the branch open.

## After acceptance

The accepted commit rebuilds `source/`, the compressed tables, the leaderboard, the views, and the badges in one parent-checked operation. Verify that the published `dataset-index.json` hashes match the published files and that `https://alexshpunt-benchmark-explorer.static.hf.space` still loads with the new observation.

Keep the local workspace out of the repository, and never hand-edit a normalized row to make a candidate pass. Fix the source and rerun instead.
