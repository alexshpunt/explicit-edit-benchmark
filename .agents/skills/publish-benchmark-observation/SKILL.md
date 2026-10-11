---
name: publish-benchmark-observation
description: Select, configure, run, and publish an observation for any registered suite in this benchmark repository. Use when asked to run or share Explicit Edit, Multi-Agent, or another supported suite with a model and harness.
compatibility: Linux, Node.js 24+, authenticated target harness, Hugging Face CLI, and the selected suite's prerequisites.
---

# Publish a benchmark observation

Work from the repository root. Paths and commands below refer to that checkout.

## Select the suite before the harness

Read `README.md` and `docs/contributing-results.md`. Preserve a suite the user
already named. If "run the benchmark" is ambiguous, ask which suite they mean;
do not silently choose the CLI default.

Discover supported suite IDs and their guides from the README and
`scripts/benchmark-suites.mjs`. There is no suite-list command. Read the selected
suite's guide and result contract before proposing a run. Use the current CLI help:

```sh
npm run benchmark -- run --help
npm run benchmark:submit -- --help
```

The CLI currently supports Explicit Edit and Multi-Agent. A future suite must
be registered and documented before it can run; an arbitrary name is not an
extension mechanism. Do not copy task counts or policies from another suite.

Resolve the suite's task scope, concurrency/team size, correction/retry policy,
deadlines, preparation, smoke gate, Score and official release availability.
The selected guide owns those rules. If a guide conflicts with the implementation,
stop and investigate rather than bypassing a rejected option.

## Resolve the configuration

Confirm only missing choices:

- local unverified observation or official verified observation;
- the registered harness family, exact model selector and reasoning level;
- the user's model account/provider route;
- the suite's permitted scope and any configurable run policy.

Use `scripts/adapter-registry.mjs` and `docs/running.md` for current adapters and
authentication. Use `configure-codex-account` or `configure-copilot-account`
for those account routes. These skills configure access; they do not choose
the benchmark or override its policy.

A custom adapter or matrix uses `--config FILE` in local mode instead of preset
flags. Read the config's profiles and policies; do not assume that one file means
one model. If the adapter is missing, use `add-benchmark-harness` first.
Treat config modules as trusted executable input, not as safe public metadata.

Official mode requires registered presets, a provider-qualified model selector,
exact `--agent-version`, and any required `--harness-version` or
`--runtime-version`. Read `docs/official-community-runs.md` and verify the
deployed caller and approved release support the selected suite. Staged source
or an older release pin is not permission to dispatch a new suite.

## Get approval before execution

Confirm the suite, all selected model/harness profiles, account, task scope,
concurrency/team size, deadlines and publication mode. Explain:

- the smoke check calls a model, and a passing smoke proceeds to the full run;
- suite preparation/reference verification may be model-free but CPU-heavy;
- an untimed suite can run indefinitely and keep spending model credit;
- local mode opens a Dataset contribution after execution;
- official mode may create a public caller repository, upload model and Hugging
  Face credentials as Actions secrets, dispatch inference and submit the result.

Obtain approval for those effects, not just for "checking the setup". Do not run
a full workload when only a smoke or a model-free check was approved.

Check the installed CLI, model access and Hugging Face login without printing
credentials. Use explicit credential/runtime files, not the whole home directory.
Keep private configs and raw evidence in ignored paths. Never put credentials,
machine paths, prompts, raw commands or output in public identity fields.

## Use the common CLI

Pass the selected suite explicitly. Let its defaults apply unless the user
approved a supported override:

```sh
npm run benchmark -- run --local --suite SUITE \
  --harness HARNESS --model PROVIDER/MODEL --thinking LEVEL
```

For a local custom config:

```sh
npm run benchmark -- run --local --suite SUITE --config PRIVATE_CONFIG
```

For an approved official preset, include its exact version flags:

```sh
npm run benchmark -- run --official --suite SUITE \
  --harness HARNESS --model PROVIDER/MODEL --thinking LEVEL \
  --agent-version AGENT_VERSION
```

The common local path prepares the config, checks identity/auth, performs the
smoke gate, executes the selected suite, exports and validates the safe bundle,
and opens the Dataset contribution. Do not add a second paid smoke or set
`ready: true` to skip it. Readiness belongs to the lower-level `raw-run` path.

If the user requested execution without publication, use the documented
`raw-run`, `export` and `inspect` path in `docs/running.md#development-commands`
instead of a command that submits automatically. Carry the same suite and
readiness requirements; a preparation proof is not a model/auth smoke.

## Inspect, recover and report

Check the actual process exit, saved report and normalized bundle. A finished
queue does not mean every task passed. Keep failed edits, correction attempts,
timeouts and legitimate early stops. Missing usage/cost stays unknown.
Never edit normalized rows to improve a result.

Publish only the common normalized bundle and safe submission metadata, never a
raw run directory or the historical standalone diagnostic export.

Structurally valid official and ordinary candidates use the common automatic
acceptance path; Score is not an admission gate. A local candidate is unverified.
A verified result requires the approved signed workflow proof.

If official delivery fails after inference, use submit-only recovery with the
original producer run ID, attempt and actual signer revision. Do not rerun the
model to repair delivery. Do not claim acceptance until its receipt is observed.

Report the suite and policy, exact model/harness/reasoning, run ID, accepted
progress and Score, wall-clock duration, available usage/cost, and workflow or
Dataset contribution URL. Distinguish submitted, accepted and deferred results.
