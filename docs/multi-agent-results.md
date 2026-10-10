# Multi-Agent result format

The candidate exports one JSON object, separate from the original Exact Edit
schema and Score. The schema version is `explicit-edit-multi-agent-result-v1`;
the benchmark id is `explicit-edit-multi-agent`; the protocol is
`shared-project-rotating-v1`.

`src/suites/explicit-edit-multi-agent/results.mjs` owns validation and the safe projection. The exporter
uses an explicit field allowlist, never spreads a raw report into public output.
The public validator rejects extra fields. A valid local file is not authenticated
evidence and does not enter the existing Dataset acceptance pipeline.

## Fields

| Field                                    | Meaning                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`, `benchmark`, `protocol` | Independent format, benchmark and execution-policy identities.                                                                                                     |
| `mode`                                   | `scripted` or `live`; reference execution is not a model result.                                                                                                   |
| `status`                                 | `pass`, `blocked`, `provider_failure`, `driver_exit`, `infrastructure`, `cancelled` or `timeout`.                                                                  |
| `identity`                               | SHA256 identities for workload, graph, schedule, ordered checkpoint contracts and initial source.                                                                  |
| `configuration`                          | Team size, graph width, observed model/reasoning/harness and pinned runtime. Unknown values are null.                                                              |
| `policy`                                 | No default deadlines, three coarse corrections, shared live workspace, ready-task barriers and rotating assignment.                                                |
| `progress`                               | Jointly accepted and total task/round counts, plus completion as a fraction from zero to one.                                                                      |
| `execution`                              | Original and correction agent deliveries together, correction deliveries separately, total wall time in milliseconds, and whether all agents closed when observed. |
| `terminal`                               | Null for a pass; otherwise only round id and safe category enums. No exception prose.                                                                              |
| `usage`                                  | Available input/output/cache/total token and configured-cost totals; null means unknown, never zero.                                                               |
| `comparisonKey`                          | SHA256 of the protocol, input/contract identities, team, harness/runtime and policy. Model and reasoning are excluded.                                             |

Progress is derived from whole passing barriers. The primary measure is
`progress.acceptedTasks / progress.totalTasks`, also stored as
`progress.completion`. An editing block requires all four attempts at the next
barrier to have failed. Provider and infrastructure errors are not renamed as
editing failures, and no partial obligation count becomes task credit.

`execution.repairs` counts correction blocks delivered to agents, not failed
barriers. A six-participant barrier corrected three times contributes 18 repair
blocks. Agents waiting in that round contribute no deliveries. Wall time includes
startup, editing, grading and closure; it is not a sum of parallel agent times.

Configurations with different team schedules are different experiments. A shared
compatibility key makes comparisons structurally compatible, not statistically
stable or causally controlled. Keep provider and model selectors visible when
comparing reasoning levels or harnesses.

## Privacy and evidence

Export omits prompts, tasks, source, receipts, commands, command output, session
ids, account details, runtime paths and free-form failure messages. Unknown raw
fields are not copied. Model selectors must be public identifiers, not account
names or private labels. Validation rejects paths and common credential prefixes;
it cannot detect every secret hidden in an otherwise valid name. Review the model
selector before sharing a result. Runtime fields contain pinned environment facts.

Export reads a finished `report.json` and writes a new JSON file. It leaves raw
reports, checkpoints and sessions untouched. It refuses existing destinations,
inconsistent progress, mismatched schedules, duplicate task assignments and
reports without the candidate protocol label. It cannot establish the truth of
hand-edited local evidence; future submission acceptance must check provenance
separately.

Historical calibration notes are reviewed facts, not retroactively exported
candidate observations. No missing runtime metadata, token totals or private
execution traces are invented to fit this format.
