# Multi-Agent results in the common protocol

Multi-Agent uses normalized schema **3**, the same five public tables and the
same submission/store/report machinery as Explicit Edit. The original suite
keeps schemas 1/2 and its existing scoring rules. Benchmark id is
`explicit-edit-multi-agent`; execution contract is `shared-project-rotating-v1`.

## Tables and joint credit

- `profiles.jsonl` records the selected model, reasoning, harness and agent identity.
- `configurations.jsonl` records the same configuration facts and hashes as the
  original suite. Tooling is not inferred from the provider or model name.
- `trials.jsonl` has one row per joint barrier. `taskIds` lists that barrier's tasks.
- `rounds.jsonl` has one row per participant delivery, with `agent`, zero-based
  `barrierAttempt` and the participant's assigned `taskIds`.
- `tool-calls.jsonl` contains the same safe native tool facts, linked to deliveries.

There are 28 barriers and 71 tasks. A passing barrier earns credit for all its
tasks; a failed barrier earns none. Score is **accepted task count / 71**, not
passed barriers / 28. No individual-agent success is invented.

The manifest's `suite` binds the workload, graph, schedule and fixed 15-agent
policy. Its per-profile `observations` preserve execution status, wall-clock
milliseconds and terminal category. Raw failure prose is not exported.

## Statistics

Native cost, tokens, tool calls, model rounds and errors are counted once per
delivery. An assignment with several tasks does not multiply its usage.
Unknown observations remain null, not zero. Costs are observed harness/runtime
metadata, not a provider billing receipt.

A correction is an additional barrier attempt. Six participants making three
corrections produce 18 correction deliveries but **three barrier corrections**.
Both delivery count and correction count remain available without confusing them.

Team duration includes startup, editing, grading and closure. It is wall-clock
time, not the sum of simultaneous participant durations. Native delivery seconds
remain available for tool/harness analysis; they do not replace team duration.
Reference execution has no model usage and must not be presented as model performance.

## Stops

An editing `blocked` result must exhaust the initial attempt and three corrections
at its next barrier. Its accepted prefix retains credit. Later barriers remain
`not-reached`, not infrastructure failures or fabricated model deliveries.

Provider, driver, infrastructure, cancellation and timeout stops are distinct.
An unsettled barrier earns no task credit. Flushed native events and usage are
retained when available. After cancellation, configurations that never started
are absent from the public bundle rather than counted as tested models.

## Validation and publication

The shared validator checks all ordinary table links and identities, plus exact
71-task membership, the 15-agent policy, schedule hashes, assigned participants,
contiguous corrections and joint grades. There is no EOF-only success for C++
restoration. Different benchmark identities do not share a ranking group.

Ordinary contributions use the existing ingestion path. Official acceptance
also requires an approved repository-owned suite registry: canonical workload,
graph, schedule, verifier and fixture hashes, fixed policy and trusted signer
and runner revisions. A self-consistent submitted schedule is not proof that it
is the approved schedule. Old policies do not authorize Multi-Agent by default.

Public output omits source, prompts, commands, stdout/stderr, sessions, account
facts, host paths and free-form terminal messages. Review public identity labels
before sharing: no pattern scanner can recognize every secret hidden in a name.
Raw evidence and private configuration stay outside Git and Dataset uploads.

## Earlier candidate exports

`explicit-edit-multi-agent-result-v1` is the earlier standalone diagnostic JSON.
Its developer exporter remains for inspecting historical candidate runs. It is
not the common submission bundle and must not be silently converted into an
authenticated observation. Historical calibration evidence stays unchanged.
