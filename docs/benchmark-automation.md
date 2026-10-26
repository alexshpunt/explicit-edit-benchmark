# Benchmark automation and public data

`npm run benchmark` is the main entry point. It resolves your model and harness combinations, runs the selected suite, exports the common safe bundle, validates it, and builds reports. The default is the original exact-file suite. `--suite explicit-edit-multi-agent` selects the fixed 15-agent, 71-task shared-project suite; see its [run policy](multi-agent.md). Both use the same configuration API and Dataset store.

## Configure models and harnesses

Start from the checked-in template:

```sh
npm run benchmark -- init
```

The generated `benchmark.config.ts` has three parts:

- `models` names your models and gives each harness the selector it needs;
- `harnesses` describes an installed, logged-in CLI;
- `selection` expands matrix blocks and explicit pairs.

A matrix runs every listed model on every listed harness. A pair adds one specific combination. The resolver rejects duplicate cells and unknown IDs. Each resolved profile keeps `profileId`, `modelId`, and `harnessId` as separate fields, so reports never have to guess them back out of a display name.

A custom harness is a trusted TypeScript module:

```ts
const myHarness = defineHarness({
  createAdapter({ model }) {
    return {
      kind: "custom",
      command: "/opt/my-agent/bin/agent",
      args: ["--model", model.selectors.myHarness, "--prompt", "{prompt}"],
      version: "1.2.3",
      model: model.selectors.myHarness,
      thinking: model.thinking,
      ready: false,
    };
  },
  inspectOutput(file) {
    // Optional: return parsed calls, model rounds, and protocol errors.
  },
  continueSession(adapter) {
    // Optional: return the adapter for the next turn in the same session.
  },
});
```

`inspectOutput` is optional for an exact one-turn run. Adapters own calling the CLI, parsing native events and continuing their own sessions. The suite owns task delivery, grading and run policy. For shared-project teams, verify continuation across assignments and corrections, independent participant state, cancellation and cleanup; a one-turn smoke does not prove these behaviors.

Pi adapter metrics retain every native assistant error in `errors`. `terminalEventErrors` counts only errors not covered by an explicitly successful native retry and a completed final assistant settlement. Recovered transport errors remain observable but do not consume a benchmark correction or abort the team. Exhausted, interrupted and unmatched retries still fail; compiler, file and pixel acceptance are unchanged.

### A harness that orchestrates another agent

Some harnesses are not one CLI call. [bb](https://getbb.app/) is an agent IDE: it starts a server, enrolls the local machine as a daemon, runs Claude Code, Codex, Pi, or OpenCode in threads, and keeps a timeline per thread. `examples/bb/` shows that shape end to end, and it works: against bb 0.43.1 one smoke task passed in about 40 seconds with two tool calls, one round, and reported tokens.

- `driver.mjs` turns one prompt from stdin into one bb thread. It starts the server and the machine daemon, registers the mounted workspace as a project, spawns a thread with bb's `project-checkout` environment so the agent edits that workspace in place, waits for the thread, and prints the timeline as JSONL on stdout.
- `timeline.mjs` maps the timeline into rounds, tool calls, and tokens. The item names come from bb's own type declarations: a file read is a read, a file change is an edit, a command is a command, and a provider tool call keeps the tool name the provider used. A conversation, reasoning, or engine item is not a call, and an item type the mapping does not know stops the run instead of silently under-counting.
- `benchmark.config.mjs` holds the identity. bb and the agent it runs are separate facts: `harnessVersion` is the bb version, `agentVersion` is the version of the provider CLI, and both come from the environment because the benchmark must not guess them.

Three details matter when you adapt this:

- Sandboxes share the host network, so the driver asks the kernel for a free port for the server and the daemon. Two concurrent trials that both used bb's default port would fight over it.
- The sandbox mounts the workspace and the state directory, nothing else. bb needs its own dependencies, which npm installs next to the package, so the adapter mounts the directory that holds `node_modules`, and the driver travels in the state directory because the repository is not mounted.
- The adapter command is Node, so `versionArgs` asks bb for its version instead of asking Node. Without it the runner refuses the mismatched `--version`.
- bb tells you turn boundaries, tool items, and token usage. It reports no cost and no failed-call count, so those stay `null`. It also totals input, cached input, and output only, so its accounting has no cache-write part.

The following bb example is for the original suite. Its concurrency and timeout
are not permitted Multi-Agent settings. A team adapter must also support the
shared-project lifecycle described above.

Run bb one trial at a time:

```sh
npm run benchmark -- check --config examples/bb/benchmark.config.mjs
npm run benchmark:submit -- --config examples/bb/benchmark.config.mjs --concurrency 1 --timeout-seconds 900
```

Every bb trial starts a server, a machine daemon, and an agent, so several trials at once compete
for the machine. The trials slow down, and the failures they produce say more about the machine
than about the harness. Sequential is also faster overall than a crowded run. The longer timeout
is for the same reason: the server has to come up before the agent starts.

If a bb run stops early, read the driver lines the harness printed to stderr. `Cannot find package 'better-sqlite3'` means the read-only mount is too narrow, and a timeout means bb never reported the thread idle within `BB_WAIT_SECONDS`.

Keep credentials out of this file when you can. Point the adapter at an existing isolated credential store, or pass local environment values through the adapter. Never submit the config, credentials, or harness state as benchmark data.

## Release-candidate automation

`.github/workflows/release-observation.yml` is a reusable workflow for release pipelines. It runs only after npm publication. It downloads the caller's validated `pi-agent-ide` artifact to verify the release identity, installs the exact published Pi Agent IDE and Pi versions from npm, runs the `pi-agent-ide` harness, submits the observation, and accepts it into the Hugging Face Dataset. Acceptance rebuilds the Dataset views and dynamic badge in the same parent-checked commit.

The caller must pass the artifact name, Pi Agent IDE version, Pi version, model, reasoning level, and concurrency. The workflow verifies that both the retained artifact name and installed npm package have the requested harness version.

The repository owner must add only these secrets to the calling repository:

- `PI_AUTH_JSON`: the complete Pi `auth.json` used to access the selected model;
- `HF_TOKEN`: a Hugging Face token with permission to open and accept pull requests in the target Dataset.

The reusable workflow needs no npm token, GitHub personal access token, provider file, or separate badge secret. GitHub supplies artifact access within the calling workflow, npm installs public packages, and Dataset acceptance rebuilds the badge.

## Running it

The [README](../README.md) has the command and its flags, and [Share a result](contributing-results.md) explains what happens while it runs. Provider routes and custom configs are extra flags on the same command.

This document covers the configuration API behind that command, the normalized data format, and the Dataset views.

## Public identity

Published data keeps four identities apart:

- **Agent** is the program that runs the model and the tool loop: Pi, Codex CLI, OpenCode, GitHub Copilot CLI, and so on.
- **Harness** is a named configuration of that agent: its tools, extensions, prompts, rules, and environment. `Pi Agent IDE` is a harness on top of the `Pi` agent. An unchanged installation is called `<agent>-default`.
- **Benchmark runner** prepares the tasks, calls the agent, applies the timeout and retry policy, and verifies the results. It is kept as provenance and shown as a filter, but it does not take a column on the leaderboard.
- **Benchmark** defines what is tested and what counts as correct.

The configuration API still uses the key `harnesses`, because each entry binds one executable agent to one harness configuration. Do not use the runner name as an agent or harness identity.

The export contains six files:

- `manifest.json`: contract, run policy, the task-set and verifier hashes, counts, sizes, and SHA-256 hashes;
- `profiles.jsonl`: agent, model, and harness families with exact versions, plus provider, adapter version, safe configuration hash, transport, and reasoning;
- `configurations.jsonl`: safe instructions for reproducing the setup, covering tools, extensions, rules, runtime flags, and required environment variable names;
- `trials.jsonl`: task and profile identity with the first and final exact result;
- `rounds.jsonl`: round outcomes in order, with timing, timeout, a nullable safe provider-failure category, step, call and error counts, and any cost or token usage seen;
- `tool-calls.jsonl`: tool names in order with a broad category, the observable outcome, and safe labels describing the command.

The contract `explicit-edit-v1` also has a [release](https://github.com/alexshpunt/explicit-edit-benchmark/releases/tag/explicit-edit-v1) under the same name, with the source archive GitHub keeps for every release. That archive is the stable way to reach the code behind a published observation, even if the repository history is rewritten later. The tag is protected: it cannot be deleted or moved.

An accepted bundle identifies itself with three facts: the contract, the SHA-256 of the task set, and the SHA-256 of the verifier module that decides correctness. A git commit is deliberately not part of that identity. It describes the checkout on the machine that ran, it cannot be checked by a reader once history is rewritten, and it adds nothing to comparability.

The original suite accepts historical schema v1 and schema v2. Schema v2 adds nullable provider-failure attribution to rounds; schema-v1 timeouts are never reclassified. Multi-Agent uses schema v3 in the same five tables, adding joint task membership and participant deliveries. Its manifest also binds the fixed team, graph, schedule and wall-clock observations. See the [team result contract](multi-agent-results.md). It keeps family identity separate from exact versions, so a consumer can group a model or harness family without losing the exact configuration behind an observation. Every profile needs `agentFamily`, `agentVersion`, `modelFamily`, `modelVersion`, a nullable `provider`, `harnessFamily`, `adapterVersion`, and sorted `configurationLabels`. The `configurationHash` fingerprints the safe recipe in `configurations.jsonl`, and profiles point at that recipe by hash. Cost, token, failed-call, and invalid-call fields are nullable on purpose: `null` means the harness never exposed that fact, `0` means it was observed as zero. Re-export old bundles from the raw run with truthful identity instead of hand-editing normalized rows.

Public views resolve known provider/selector aliases through the model registry. If a contributor used a registered alias as the model family, the view shows its canonical family and reconnects projected configuration hashes. The wire selector and retained source bundle stay unchanged. Explicit historical model families and versions are not relabelled just because a moving alias now points elsewhere. Unknown routes keep the submitted identity.

For a model-only rebuild, dispatch the serialized acceptance workflow with `rebuild_only=true` and `model_projection_only=true`. Before publishing, it checks every retained source file, run identity, outcome, timing and usage table. Its result reports changed model profiles and their token/cost totals. The pre-rebuild snapshot is retained for recovery.

Rebuild snapshot downloads are pinned to the parent revision. If the connection is closed during download, the job makes at most three attempts using the same cache, so completed files are not downloaded again. Other errors stop the job immediately; publication still happens only after the snapshot, backup and checks succeed.

The exporter drops prompts, model prose, raw arguments, command text, command output, workspaces, and credential state. For shell calls it publishes labels such as `search`, `read`, `test-or-build`, or `likely-workspace-write` instead of the command itself. The validator checks file hashes, counts, duplicate IDs, foreign keys, and fields that must never appear.

EOF-normalized correctness is complete only when the run has reviewed failure evidence in `failure-review/cases.json`. Without that review, failed rounds are marked `unknown` and the manifest says the EOF classification is partial. Exact correctness is available either way.

`report` writes a Markdown scoreboard and a CSV from the normalized bundle. Bigger accepted reports can rebuild family, recovery, failure-overlap, and tool-use views from the same facts.

## What we keep

We do not publish complete `results/` directories. They can hold duplicated workspaces, raw logs, sessions, and credentials. Those bytes are unsafe and add nothing to the public statistics.

Accepted source bundles are retained separately from generated views. Use the Dataset index for current run/configuration counts rather than a fixed number in this guide.

The layers are:

1. **Benchmark GitHub repository**: benchmark code, schema, validation, aggregation, and publication commands.
2. **Hugging Face Dataset**: accepted source bundles plus deterministic generated views.

The Dataset is the durable evidence and query layer, and the only result store. The first version uses no Git LFS and no mutable SQL database.

## Build dataset shards

A maintainer can turn reviewed bundles into gzip JSONL shards for Hugging Face:

```sh
npm run benchmark -- dataset --output public-dataset \
  accepted/run-a/normalized accepted/run-b/normalized
```

Every row gains a `runId`. `dataset-index.json` records the source manifest hashes, contracts, task-set hashes, completeness, counts, and the hash of every compressed shard. Building the dataset neither uploads it nor reads a Hugging Face token. An acceptance build also writes `leaderboard.json`, `views.json`, and `data/explorer-summary.json.gz` from the same aggregation module. `views.json` holds the precomputed group, task-family, tool-usage, and drill-down views. The Explorer summary contains only the public UI fields needed for ordinary interaction, so its deployment reads one checked file instead of downloading every historical shard. Acceptance also writes one content-addressed detail package per run. The browser fetches and verifies that package only when the run is opened.

Useful Hugging Face references: [Datasets](https://huggingface.co/docs/hub/datasets-overview), [Data Studio](https://huggingface.co/docs/hub/data-studio), and [storage limits](https://huggingface.co/docs/hub/storage-limits).

## Hugging Face contribution flow

The Hugging Face dataset `main` branch is the only durable home for accepted observations. It stores accepted bundles under `source/`. The compressed tables, dataset card, `leaderboard.json`, `views.json`, `data/explorer-summary.json.gz`, `summary.json`, and `dataset-index.json` are generated views. Acceptance calculates Score and every ranking view before publication.

Contributors log in with their own Hugging Face token and open a dataset pull request:

```sh
hf auth login
npm run benchmark -- submit results/my-run/normalized \
  --repository OWNER/DATASET \
  --metadata submission-metadata.json
```

The command runs the normalized validator and the strict ingestion validator locally, then uploads these files under `candidates/RUN_ID/`:

- `manifest.json`;
- `profiles.jsonl`;
- `configurations.jsonl`;
- `trials.jsonl`;
- `rounds.jsonl`;
- `tool-calls.jsonl`;
- `submission.json`, with safe contributor and benchmark metadata.

It uploads no prompts, model prose, command text, raw arguments, output, sessions, workspaces, credentials, or local paths. Your Hugging Face token goes only to the Hub API and is never written into the candidate.

## Accept a candidate

Scheduled automation accepts structurally valid ordinary and official candidates;
Score is not an admission gate. Code and policy changes still need review.
The [candidate review skill](../.agents/skills/review-benchmark-candidate/SKILL.md)
and [official operations guide](official-community-runs.md#operations-and-recovery)
describe investigation, queue exclusions and explicit recovery.

For an explicitly requested manual investigation, use a server-side dry run:

```sh
gh workflow run accept-huggingface-observation.yml \
  -f dataset_repository=OWNER/DATASET \
  -f candidate_ref=PR_NUMBER_OR_REF \
  -f dry_run=true
```

Production manual dispatch requires separate approval. Do not download or run
production acceptance from a maintainer workstation.

Normal acceptance reads three compact state files and only the immutable
candidate bundle. It validates identity, schema, hashes, links, safe metadata and
suite compatibility; retains the source bundle; adds one new shard per table;
and updates aggregate state and compact views. It does not copy the complete
source store or rebuild every historical shard.

Publication is one parent-checked Hub commit. If Dataset main changed,
acceptance fails closed; the next serialized pass reloads that head and reapplies
the unchanged candidate. After publication it posts a receipt and closes the
candidate instead of using the Hub merge action. If receipt delivery fails,
keep the accepted commit and reconcile delivery without repeating the append.

A full snapshot/rebuild is an explicit recovery operation, not normal candidate
acceptance. Production credentials stay on the workflow; contributors use their
own account to submit, never a maintainer token.

After a real Dataset change, acceptance sends a `dataset-updated` repository dispatch to `alexshpunt/benchmark-explorer`. Configure `EXPLORER_DISPATCH_TOKEN` as a repository secret with permission to dispatch events to that repository. Prefer a short-lived GitHub App token with only the required repository access. Dry runs and duplicate candidates do not send an event. If the secret is absent, publication still succeeds and the workflow records a warning so the Explorer's scheduled revision check can recover.
