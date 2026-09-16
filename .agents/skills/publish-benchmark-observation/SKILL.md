---
name: publish-benchmark-observation
description: Configure, smoke-test, run, and submit an Explicit Edit Benchmark observation to Hugging Face.
compatibility: Linux, Node.js 24+, authenticated target harness, Hugging Face CLI, and this repository's installed dependencies.
---

# Publish a benchmark observation

## Read first

- `README.md`
- `docs/contributing-results.md`
- `docs/running.md`, when the agent needs a provider route or a custom config

If the agent has no ready adapter, use `add-benchmark-harness` first.

For a verified community result, prefer the public [official run template](https://github.com/alexshpunt/explicit-edit-benchmark-run-template). It accepts only registered official inputs, supports partial runs, attests the exact result, and is accepted automatically. Use the local flow below for development or an unverified contribution.

## Ask for three things

1. the harness family: `pi-default`, `pi-agent-ide`, `codex-cli-default`, `opencode-default`, `oh-my-pi-default`, `github-copilot-cli-default`, `dsh-standard`, or `dsh-code`;
2. the exact model id;
3. the reasoning level.

Everything else is automatic. A custom adapter or a config you already have uses `--config FILE` instead of `--harness`, and then you do not need these three answers.

## Check before you start

Make sure the agent CLI is installed and logged in, and that the user has run `hf auth login`.

The command writes its own temporary configuration into the system temp folder and deletes it at the end, so nobody prepares or commits a config file for a ready adapter.

Never copy credentials, local paths, prompts, raw commands, or command output into configuration or metadata.

## Know what the smoke task does

`benchmark:submit` runs one exact task (`replace-all-10-plain`) for every selected profile and compares the resulting files byte for byte. If any profile fails, it stops before the paid full run.

Do not ask the user to run a separate smoke, and do not set `ready: true`. That flag only gates a direct `npm run benchmark -- run`. The submit command authorizes its own run once the smoke passes.

Ask the user before starting, because a passing smoke goes straight into a paid full run. Tell them the model, the harness, the task count, and the concurrency.

## Run and submit

Make sure the user has run `hf auth login`, then run:

```sh
npm run benchmark:submit -- --harness HARNESS --model MODEL --thinking LEVEL --concurrency 10
```

`--concurrency` is how many tasks run at once. It changes how long the run takes, not the result. Add provider flags only when the agent needs a local route, for example `--provider-file provider.json --env-file private-env.json`. Run `npm run benchmark:submit -- --help` for every option.

The command prepares the config, checks the agent and the Hugging Face login, smoke-tests every profile, runs all 226 tasks, exports and validates the bundle, builds safe submission metadata, and opens a pull request against the Hugging Face Dataset `alexshpunt/explicit-edit-benchmark`.

It always uses five Oracle recovery attempts and a 120-second timeout.

Keep failures, timeouts, and recovery rounds. Never edit normalized rows to improve a result. Report the run ID and the pull request URL.

## Acceptance

Official candidates are verified and accepted automatically by the repository workflow. Do not ask for manual approval based on score. If delivery fails after inference, use the template's submit-only recovery with the original run ID and attempt.

Ordinary local candidates remain unverified and follow the contribution review process. Code, adapter, task, workflow, and policy changes always require normal review.
