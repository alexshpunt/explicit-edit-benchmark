<p align="center">
  <img src="assets/logo.png" alt="Explicit Edit Benchmark" width="560">
</p>

<h1 align="center">Explicit Edit Benchmark</h1>

<p align="center">Explicit Edit is an open benchmark for measuring how accurately coding agents and agent harnesses edit files across 226 deterministic, byte-exact tasks.</p>

<p align="center">
  <a href="https://github.com/alexshpunt/explicit-edit-benchmark/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/alexshpunt/explicit-edit-benchmark/ci.yml?branch=main&label=CI%2FCD" alt="CI/CD status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark"><img src="https://img.shields.io/badge/dataset-Hugging%20Face-f0c04a" alt="Hugging Face Dataset"></a>
  <a href="https://huggingface.co/spaces/alexshpunt/benchmark-explorer"><img src="https://img.shields.io/badge/leaderboard-Explorer-2f6fe4" alt="Benchmark leaderboard"></a>
</p>

<p align="center">
  <a href="https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark"><img src="https://img.shields.io/badge/tasks-226%20exact%20edits-blue" alt="226 tasks"></a>
  <a href="https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fhuggingface.co%2Fdatasets%2Falexshpunt%2Fexplicit-edit-benchmark%2Fresolve%2Fmain%2Fsummary.json&query=%24.observations&label=observations&color=blue" alt="Accepted benchmark observations"></a>
  <a href="https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fhuggingface.co%2Fdatasets%2Falexshpunt%2Fexplicit-edit-benchmark%2Fresolve%2Fmain%2Fsummary.json&query=%24.models&label=models&color=blue" alt="Models in the benchmark dataset"></a>
  <a href="https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fhuggingface.co%2Fdatasets%2Falexshpunt%2Fexplicit-edit-benchmark%2Fresolve%2Fmain%2Fsummary.json&query=%24.configurations&label=configs&color=blue" alt="Configurations in the benchmark dataset"></a>
</p>

The tasks are small on purpose. None of them needs deep reasoning or domain knowledge: the agent finds the right text, changes it, and leaves every other byte as it was. That keeps the attention on what actually differs between setups, which is the model, the tools, and the harness around them.

There are 226 of them: replacements, insertions, deletions, copies, moves, large files, several file types, and Unicode edge cases. A verifier compares the result byte for byte.

**Where results live:** the [Benchmark Explorer](https://huggingface.co/spaces/alexshpunt/benchmark-explorer) shows current rankings, and the [Hugging Face Dataset](https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark) stores every accepted run.

The benchmark grows with the people who run it. Run it on your own harness and configuration, publish the result, and it joins the same database and counts towards the statistics.

There is room for more than this, too: longer and more involved edits are planned, closer to the work people do when they change software. Ideas are welcome as issues, pull requests are reviewed and merged when they help, and the author is open to discussing any of it.

## What you need

- Linux or WSL2
- Node.js 24 or newer
- Python 3
- Bubblewrap (`bwrap`)
- the agent CLI you want to test, installed and logged in
- access to the model you want to test
- a free [Hugging Face account](https://huggingface.co/join) to submit the result

Clone the repository, then install it and the Hugging Face CLI:

```sh
git clone https://github.com/alexshpunt/explicit-edit-benchmark.git
cd explicit-edit-benchmark
npm ci
python3 -m pip install --upgrade huggingface_hub
hf auth login
```

## Pick your agent

The benchmark has ready adapters for these CLIs. Use the name in the `--harness` flag.

| `--harness`                  | Runs                                                                                                                | Binary     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| `pi-default`                 | [Pi](https://pi.dev/)                                                                                               | `pi`       |
| `pi-agent-ide`               | [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide)                                                          | `pi`       |
| `codex-cli-default`          | [Codex CLI](https://github.com/openai/codex)                                                                        | `codex`    |
| `opencode-default`           | [OpenCode](https://github.com/anomalyco/opencode)                                                                   | `opencode` |
| `oh-my-pi-default`           | [Oh My Pi](https://github.com/can1357/oh-my-pi)                                                                     | `omp`      |
| `github-copilot-cli-default` | [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) | `copilot`  |
| `dsh-standard`               | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), native tools                                   | `dsh`      |
| `dsh-code`                   | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), code mode                                      | `dsh`      |

The name in the flag is the published harness family, so a result lands in the leaderboard under the name you ran. The binary column is what actually runs; pass a different path with `--command` when yours is not on `PATH`. `pi-default` and `pi-agent-ide` both run `pi`, and differ only in the tools.

You install and sign in to that CLI yourself. The benchmark leaves your CLI alone, and your credentials stay yours: it copies only the file you point it at, for the length of a run.

For anything not in this list you write your own adapter. [Benchmark automation and public data](docs/benchmark-automation.md) documents the config API, and [examples/bb](examples/bb/benchmark.config.mjs) is a worked example for a harness that is more than one CLI call: it starts a server, runs another agent in a thread, and reads that thread's timeline. We ship the example and a smoke run, not a bb result.

## Run it

One command does the whole run. You choose the harness, the exact model, and the reasoning level:

```sh
npm run benchmark:submit -- --harness pi-default --model PROVIDER/MODEL --thinking high --concurrency 10
```

You can run that yourself, or hand your coding agent this repository link and let it do the work: the skills in `.agents/skills/` know how to route a harness to your account, run the observation, and open the pull request. Ask it to publish a result and it will use them.

| Flag            | What it means                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--harness`     | The harness from the table above.                                                                                                         |
| `--model`       | The exact model id, spelled the way that CLI expects it.                                                                                  |
| `--thinking`    | The reasoning level, for example `low`, `medium`, or `high`.                                                                              |
| `--concurrency` | How many tasks run at once. Default 10. It changes how long a run takes, and under heavy contention it can also change which trials fail. |

Then the command does the rest:

1. builds a temporary configuration for the agent you picked, and checks the binary and its version;
2. checks the Hugging Face login;
3. runs one exact task for every selected configuration and compares the files byte for byte;
4. runs all 226 tasks;
5. exports the result, validates it, and opens a pull request on the Dataset.

**If step 3 fails, the command stops there**, so a misconfiguration costs you a minute instead of a full run. That check is part of the command rather than something you have to remember.

Every run sees the same 226 tasks. A run is grouped with others only when the rules match: how many recovery attempts it allows, how long one attempt may take, the task set, and the verifier. How many trials ran at once is recorded too, but it does not separate groups, because it is scheduling rather than a rule; it shows up in timings, and under contention sometimes in failures. If a harness needs longer, raise `--timeout-seconds`, and the result is compared with runs that used the same timeout.

Some agents need a provider route or a credential file. That is one more flag on the same command:

```sh
npm run benchmark:submit -- --harness codex-cli-default --model PROVIDER/MODEL --thinking high \
  --provider-file provider.json \
  --env-file private-env.json
```

`provider.json` holds routing metadata and no key. `private-env.json` holds the key itself. Keep both files private. The [configuration guide](docs/running.md) explains each adapter's quirks, the runtime and mount rules, and the files each CLI expects.

If you keep your own `benchmark.config.ts`, submit it with `--config benchmark.config.ts` instead of `--harness`. Run `npm run benchmark:submit -- --help` for every option.

## What gets published

The pull request holds benchmark facts: task results, exact versions, timings, tool-call categories, and a safe copy of the configuration recipe. It holds no credentials, local paths, prompts, model prose, raw commands, command output, sessions, or workspaces, and your Hugging Face token only ever goes to the Hub API.

Keep the failures, timeouts, and recovery attempts in the result, because a published number is only useful when it is the real one. If a row is wrong, fix it at its source and rerun instead of editing the exported file.

## Show your result

Once your run is accepted, you can show its score in your own README:

```md
[![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/pi-agent-ide.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Api-agent-ide%400.5.1)
```

The Dataset publishes one badge per harness family under `badges/`, named after the family. Clicking a badge opens that harness version’s card while keeping the full comparison visible. This is how they look right now:

| Family                       | Badge                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-default`                 | [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/pi-default.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Api-default%400.85.1)                                                           |
| `pi-agent-ide`               | [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/pi-agent-ide.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Api-agent-ide%400.5.1)                                                        |
| `codex-cli-default`          | [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/codex-cli-default.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Acodex-cli-default%40codex-cli%200.153.4)                                |
| `opencode-default`           | [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/opencode-default.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Aopencode-default%401.18.29)                                              |
| `oh-my-pi-default`           | [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/oh-my-pi-default.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Aoh-my-pi-default%40omp%2F18.1.14)                                        |
| `github-copilot-cli-default` | [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/github-copilot-cli-default.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Agithub-copilot-cli-default%40GitHub%20Copilot%20CLI%201.0.83.) |
| `dsh-standard`               | [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/dsh-standard.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Adsh-standard%400.1.2-rc.1)                                                   |
| `dsh-code`                   | [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/dsh-code.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Adsh-code%400.1.2-rc.1)                                                           |

Each badge shows that family's score across its accepted configurations, on the same scale the Explorer uses. The color follows the score: 90% and up is bright green, then green from 75%, yellow from 50%, orange from 25%, and red below that.

The badge is a small JSON file served by the Dataset, so [shields.io](https://shields.io/badges/endpoint-badge) renders it and it refreshes whenever acceptance rebuilds the Dataset.

## Check the code without spending money

```sh
npm run check
```

It runs formatting, linting, type checks, the unit and integration tests, and one deterministic sandbox trial. No paid model calls are involved, so it is a cheap way to check a clone or a change before running anything real.

## Where to read more

| Document                                                             | What it adds                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Configuration guide](docs/running.md)                               | Per-adapter model and auth details, provider routes, mounts, lower-level commands  |
| [Share a result](docs/contributing-results.md)                       | The submission flow step by step, and what happens after you open the pull request |
| [Benchmark automation and public data](docs/benchmark-automation.md) | The config API, the normalized data format, and the Dataset views                  |
| [Methodology](docs/methodology.md)                                   | How tasks are generated, what the scores mean, and how recovery works              |
| [Architecture](docs/architecture.md)                                 | Where each fact lives, and which layer owns what                                   |

## Skills for coding agents

These are instructions that a coding agent loads on its own rather than documents to read. They live in `.agents/skills/`, and an agent that supports skills picks them up when a task matches, so it is enough to ask for the job.

| Skill                           | The job it covers                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `configure-codex-account`       | Run Codex on a ChatGPT subscription, an API-key route, or a Chinese provider such as Z.AI or DeepSeek |
| `configure-copilot-account`     | Run Copilot on its own GitHub account, a provider key, or an OAuth-only plan through a local bridge   |
| `add-benchmark-harness`         | Add an adapter for another agent CLI                                                                  |
| `publish-benchmark-observation` | Run a full observation and open the Dataset pull request                                              |
| `review-benchmark-candidate`    | Review, validate, and accept a contributed result                                                     |
