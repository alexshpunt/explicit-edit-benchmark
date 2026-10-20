# Multi-Agent results in the common protocol

Multi-Agent uses normalized schema **3**, the same five public tables and the
same submission/store/report machinery as Explicit Edit. The original suite
keeps schemas 1/2 and its existing scoring rules. Benchmark id is
`explicit-edit-multi-agent`; execution contract is `shared-project-rotating-v1`.
This is the first public Multi-Agent version, v1. Its atomic dispatch identity is
versioned separately; it does not rename the benchmark release.

## Tables and joint credit

- `profiles.jsonl` records the selected model, reasoning, harness and agent identity.
- `configurations.jsonl` records the same configuration facts and hashes as the
  original suite. Tooling is not inferred from the provider or model name.
- `trials.jsonl` has one row per joint barrier. `taskIds` lists that barrier's tasks.
- `rounds.jsonl` has one row per actual participant delivery, with `agent` and
  zero-based `barrierAttempt`. An atomic delivery has `atomicId` and exactly one
  parent scoring group in `taskIds`. A participant can deliver many atoms in one
  barrier attempt.
- A global correction uses `deliveryKind: "barrier-repair"`, no `atomicId`, and all
  of that barrier's parents in `taskIds`. It starts only after the initial attempt.
- `tool-calls.jsonl` contains the same safe native tool facts, linked to deliveries.

There are 28 full barriers and 71 scoring groups. A passing barrier earns joint
credit for all its groups; a failed barrier earns none. **Score = 75% first-pass
success + 25% eventual success**, task-weighted over all 71 groups, not averaged
over barriers or atomic deliveries. First-pass means initial-attempt acceptance;
eventual means acceptance within the six-attempt budget. Atomic passes remain
scheduler evidence, not additional Score tasks. No individual-agent score is
invented.

The manifest's `suite` binds the workload, graph, schedule and fixed 15-agent
policy. For the current stream, `suite.atomic` also records the atomic version,
`workloadSha256`, `batchesSha256`, `dispatchPolicySha256` and `edits` inventory count.
That count measures atomic units, not semantic bindings: a compiler-certified
inseparable overload group is one unit even though it contains several bindings.
Neither count changes the 71-group Score denominator.
The private batch hash binds compiler-certified plans and expected-state data;
those contents stay on the controller. Only safe identities and counts enter the
bundle. Per-profile `observations` preserve execution status, wall-clock
milliseconds and terminal category. Raw failure prose is not exported.

## Statistics

Native cost, tokens, tool calls, model rounds and errors are counted once per
actual delivery. A global repair naming several groups does not multiply its
usage. Retained atomic completions do not create new delivery or usage rows.
Unknown observations remain null, not zero. Costs are observed harness/runtime
metadata, not a provider billing receipt.

A correction is an additional barrier attempt, not an individual delivery.
Several atomic repairs or one global repair can occur within that attempt. Keep
barrier corrections separate from native delivery counts; neither changes the
71-group denominator.

Team duration includes startup, editing, grading and closure. It is wall-clock
time, not the sum of simultaneous participant durations. Native delivery seconds
remain available for tool/harness analysis; they do not replace team duration.
Reference execution has no model usage and must not be presented as model performance.

## Stops

An editing `blocked` result must exhaust the initial attempt and five corrections
at its next barrier. Its accepted prefix retains credit. Later barriers remain
`not-reached`, not infrastructure failures or fabricated model deliveries.

Provider, driver, infrastructure, cancellation and timeout stops are distinct.
An unsettled barrier earns no task credit. Flushed native events and usage are
retained when available. After cancellation, configurations that never started
are absent from the public bundle rather than counted as tested models.

## Validation and publication

The shared validator checks all ordinary table links and identities, plus exact
71-task membership, the 15-agent policy, schedule hashes, atomic identities,
observed delivery-to-parent links, actual participants, contiguous corrections
and joint grades. There is no EOF-only success for C++ restoration. Different
benchmark identities do not share a ranking group.

Ordinary contributions use the existing ingestion path. Official acceptance
also requires an approved repository-owned suite registry: canonical workload,
graph, schedule, verifier and fixture hashes, atomic workload and private-batch
hashes, dispatch policy, complete atomic inventory, and trusted signer and runner
revisions. It requires a matching reviewed full 71-group/28-barrier atomic proof.
A self-consistent submitted schedule or partial certification is not that proof.
The official gate remains closed until the proof and releases are approved;
old coarse policies and experimental records do not authorize the stream.

Public output omits source, prompts, commands, stdout/stderr, sessions, account
facts, host paths and free-form terminal messages. Review public identity labels
before sharing: no pattern scanner can recognize every secret hidden in a name.
Raw evidence and private configuration stay outside Git and Dataset uploads.

## Earlier candidate exports

`explicit-edit-multi-agent-result-v1` is the earlier standalone diagnostic JSON.
The developer exporter handles the currently supported run contract. This JSON
is not the common submission bundle and must not be silently converted into an
authenticated observation. Earlier experimental and calibration files remain
historical evidence; they are not proof of the current atomic stream.
