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
- **Multi-Agent** uses a pinned C++ fixture. Preparation certifies binding and
  structural units and seals their dependency graph. Exactly 15 persistent
  participants share one writable project. A free participant receives one ready
  atomic request, with rotating ownership. Lightweight output gates unlock
  successors; 28 drained full barriers check cumulative obligations, fresh builds
  and repeated pixels before granting credit to the original 71 groups.

The [Multi-Agent source map](multi-agent.md#source-layout) separates generation,
tasks, execution, grading, reference editors and C++ analysis. Full and coherent
reference routes remain preparation dependencies. Older experiment commands are
developer tools, not another publication protocol.

Harness identity and task delivery are separate. `scripts/adapter-registry.mjs`
owns registered presets; `benchmark-config.mjs` expands matrices and pairs.
Adapters own calling the CLI, parsing its native events and continuing a session.
Suite code owns task scheduling and grading. The atomic controller keeps verified
completion separate from a settled response or pending peer observation. It
rechecks prerequisites and retains only still-valid completions through barrier
corrections. A global barrier repair is a separate delivery within the same
six-attempt budget, not a new scoring task. The [run policy](multi-agent.md#run-policy-and-score)
owns the detailed scheduling and correction contract. Selecting a harness must
not replace it with Baseline Agent or infer tool usage from whether a task passed.

Each participant sees the current assignment and live source, not future tasks,
reference source, private binding batches, contracts or expected pixels. Private
expected-state replay and structural checkpoint decisions stay on the controller.
Reference workers receive an explicit editing-code allowlist; their shared isolated
analysis service accepts already-dispatched current requests only. One planning
slot does not reduce participant concurrency. Mounting the whole trusted checkout
or prepared answers would break that boundary.

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
to participants. The manifest binds the workload, graph, schedule, fixed team
and wall-clock observations. `suite.atomic` adds atomic workload and private-batch
hashes, dispatch-policy hash and inventory count without exposing private contents.
See the [team result contract](multi-agent-results.md).

A barrier can contain several scoring groups and many atomic deliveries from the
same participant. Global barrier repair has its own delivery kind. Retained
completion does not create a new delivery. Native events are counted once, not
once per parent group. Joint acceptance is all-or-nothing at a barrier. Failed
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
runner and suite identities. Multi-Agent requires a maintainer-owned reviewed
record binding the workload, fixture, graph, schedule, verifier, atomic hashes,
dispatch policy and complete inventory. Approval requires a fresh model-free
71-group/28-barrier atomic proof; partial certification and experimental coarse
records do not authorize the stream. The official gate remains closed without
that proof and explicit release activation. Its fixed team and lack of task
deadlines do not relax original-suite policies. Maintainer reference evidence is
not a model observation and is not taken from contributor-supplied approval hashes.

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
- Multi-Agent: 0.75 × first-pass success + 0.25 × eventual success, task-weighted
  over the same 71 canonical groups. Only a passing full barrier grants either
  kind of credit; atomic completion counts do not enlarge the denominator.

Rankings stay separate by suite and comparable policy. Duration, cost, tokens
and tool usage remain shared statistical facts, not Multi-Agent Score weights.
Corrections affect first-pass versus eventual outcomes but do not create extra
scoring groups. Historical calibration runs are labelled separately,
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
