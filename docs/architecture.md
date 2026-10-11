# Benchmark architecture

The repository contains two benchmark suites and one shared execution and
publication system. Suites define what agents must do and what counts as correct.
The common layers configure harnesses, collect native evidence and publish results.

## One home for each fact

| Layer              | Home                                                                                                           | Responsibility                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Suite definition   | `src/suites/` and `fixtures/`                                                                                  | Workload, task identity, correctness, run policy and suite-specific Score                   |
| Common runner      | `scripts/benchmark*.mjs`, `harness-runtime.mjs` and `harness-participant.mjs`                                  | CLI selection, model × harness profiles, sandbox lifecycle and native receipts              |
| Local evidence     | Private `results/` and preparation directories                                                                 | Source, sessions, commands and raw logs from one execution                                  |
| Normalization      | `scripts/normalized-run.mjs` and `validate-normalized-run.mjs`                                                 | Safe shared tables, identities, links, hashes and validation                                |
| Accepted evidence  | [Hugging Face Dataset](https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark), `source/accepted/` | Retained observations, submission provenance and official proof where present               |
| Generated analysis | The same Dataset                                                                                               | Suite rankings, summaries, indexes, badges and Explorer data rebuilt from accepted evidence |

This GitHub repository owns the definitions and calculations, not the accepted
result corpus. The Dataset is the only result store. The Explorer consumes
generated views; it does not invent another Score.

## Suite and harness boundaries

`scripts/benchmark-suites.mjs` resolves the supported suite and public scheduling
constraints before credentials or harnesses are accessed. It currently selects
between two suites, not arbitrary plugins. Original Explicit Edit remains the
default. A new suite needs an implemented contract, routing, validation and
release policy; adding a name to documentation is not enough.

- **Explicit Edit** generates its initial and expected files in code. Independent
  trials receive a task, edit their own workspace and pass byte-exact verification.
- **Multi-Agent** uses a pinned C++ fixture. Preparation proves the restoration
  workload and dependency graph. A fixed team shares one writable project, with
  separate participant histories and rotating assignments. Each barrier checks
  cumulative obligations, a fresh build and repeated rendered images.

The [Multi-Agent source map](multi-agent.md#source-layout) separates generation,
tasks, execution, grading, reference editors and C++ analysis. Full and coherent
reference routes remain preparation dependencies. Older experiment commands are
developer tools, not another publication protocol.

Harness identity and task delivery are separate. `scripts/adapter-registry.mjs`
owns registered presets; `benchmark-config.mjs` expands matrices and pairs.
Adapters own calling the CLI, parsing its native events and continuing a session.
Suite code owns task scheduling and grading. Selecting a harness must not replace
it with Baseline Agent or infer tool usage from whether a task passed.

Each participant sees the current assignment and live source, not future tasks,
reference source, private contracts or expected pixels. Reference workers receive
an explicit source allowlist; mounting the whole trusted checkout would break
that boundary.

## Shared result protocol

The exporter produces one manifest and five tables:

```text
manifest.json
profiles.jsonl
configurations.jsonl
trials.jsonl
rounds.jsonl
tool-calls.jsonl
```

Profiles keep agent, harness, model, provider, reasoning and exact versions apart.
Configurations contain safe public recipes and environment variable names, never
credentials or executable local state. Trials describe correctness; rounds and
tool calls describe native deliveries, usage and observed errors. Unknown metrics
stay null rather than becoming zero.

The original suite retains historical schemas 1 and 2. Schema 2 adds safe
provider-failure attribution. Multi-Agent uses schema 3 in the same tables:
trial rows link barriers to canonical tasks; round/call rows link native deliveries
to participants. The manifest binds the workload, graph, schedule, fixed team and
wall-clock observations. See the [team result contract](multi-agent-results.md).

A barrier can contain several tasks and deliveries. Native events are counted
once, not once per task. Joint acceptance is all-or-nothing at a barrier. Failed
corrections retain state; unreached tasks do not become infrastructure failures.
Provider, driver and cancellation stops retain the accepted prefix but are not
editing failures. Team duration is wall-clock time, not summed participant time.

The safe bundle excludes source, prompts, model prose, command text, raw arguments,
logs, sessions, credentials and local paths. Raw run directories remain private
even when the normalized bundle is safe.

## Admission and trust

Ordinary contributors open a Dataset candidate with their own Hugging Face
account. Local observations are `unverified`. Official candidates carry the
signed archive, attestation and exact execution identity; they become `verified`
only after trusted proof validation.

`scripts/official-policy.mjs` and `policies/official-runs/` bind approved workflow,
runner and suite identities. Multi-Agent has its own approved workload, fixture,
graph, schedule and verifier record. Its fixed team and lack of task deadlines
do not relax original-suite policies. Maintainer reference evidence is not a model
observation and is not taken from a contributor's submitted approval hashes.

Release preparation pins both the producer and submit-only recovery callers.
The [release guide](official-run-release.md) describes that transaction.
Prepared branches are not deployed authorization: caller and policy activation
must happen explicitly before a new official suite can run.

Admission checks safety, structure, identities, hashes and proof, not Score.
Structurally valid low-score or correction-exhausted observations are useful data.
Code, task, adapter and release changes still need normal pull-request review.

## Incremental acceptance

Scheduled acceptance processes candidates serially against the current Dataset
head. Its normal append path:

1. reads the compact source index, Dataset index and aggregate state;
2. downloads only the immutable candidate files and validates them;
3. retains the source bundle and adds one compressed shard per table;
4. appends aggregate state and regenerates compact views, indexes and the Dataset card;
5. publishes one parent-checked commit, then posts the receipt and closes the candidate.

It does not download or rebuild all historical source on every submission.
If the parent moved, acceptance fails closed and retries from the new head.
A receipt failure does not erase a successful Dataset commit. Official delivery
can reuse the retained signed artifact without repeating inference.

Full snapshots and rebuilds are explicit recovery operations, with a retained
backup. See [official operations and recovery](official-community-runs.md#operations-and-recovery).

## Scores and comparisons

`scripts/result-aggregation.mjs` owns both calculations:

- Original Explicit Edit: coverage × (0.75 × first exact rate + 0.25 × final exact rate).
- Multi-Agent: jointly accepted canonical tasks / 71.

Rankings stay separate by suite and comparable policy. Duration, cost, tokens,
corrections and tool usage remain shared statistical facts; they do not weight
the Multi-Agent Score. Historical calibration runs are labelled separately,
not relabelled as common-protocol observations.

Provider quarantine uses confirmed attribution and observed execution counts,
not the unreached suffix. Schema-1 history is not retroactively attributed.
Details live in [methodology](methodology.md) and the [team result contract](multi-agent-results.md).

## Further reading

- [Run and configure a harness](running.md)
- [Multi-Agent workload and run policy](multi-agent.md)
- [Share a result](contributing-results.md)
- [Configuration API and public data](benchmark-automation.md)
- [Official community runs](official-community-runs.md)
