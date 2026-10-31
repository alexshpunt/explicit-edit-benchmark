# Canonical-diff round scoring

This methodology is under implementation. It is separate from accepted-prefix and
restoring atom-score observations. Historical evidence, proofs and scores retain
their original interpretation.

## Local commands

Use a new cache and output directory for each preparation or observation. The cache
contains private trusted endpoints and is not an editing-worker mount. Cache format
v2 retains raw source endpoints as well as canonical snapshots and hunks. Loading
validates the original input fingerprint, retained proof, source identities and
canonical artifacts without applying the workload again or preparing legacy repair
scopes. Older caches need explicit preparation; loading never falls back to replay.
Its verifier identity invalidates the cache when implementation code changes.

Preparation can replay the workload once, or use `--trusted-endpoints PRIVATE_JSON`
to reuse saved source states. The endpoint file has version
`renderer-retained-source-endpoints-v2`, the exact original input fingerprint,
retained-proof SHA-256, initial source tree and ordered `{round, identity, tree}`
endpoints. Every source identity must match the retained proof. The input
fingerprint must be sealed when those trusted artifacts are collected, not
replaced to accept modified inputs. This path runs no reference execution.

```sh
node scripts/multi-agent.mjs prepare-canonical PREPARATION NEW_CACHE --proof RETAINED_PROOF --agents 15
node scripts/multi-agent.mjs run-canonical PREPARATION NEW_OUTPUT --canonical NEW_CACHE --config PRIVATE_JSON --allow-model-calls --agents 15 --batch-size 10 --max-concurrent-agents 30
node scripts/multi-agent.mjs export-canonical NEW_OUTPUT NEW_RESULT_JSON
node scripts/multi-agent.mjs validate-canonical NEW_RESULT_JSON
node scripts/multi-agent.mjs inspect-canonical NEW_OUTPUT
```

The run command spends model credit and needs separate run authorization. There is
no `verify-canonical` reference-execution command. `--agents` retains the workload's
original graph schedule; `--max-concurrent-agents` bounds the new process pool.
The participant configuration uses the isolated native runtime fields documented
in the Multi-Agent run guide. Omit its legacy `agentLifecycle` field or set it to
`round-ready-pool`; canonical execution does not accept a persistent or per-packet
lifetime override. At most eight participants initialize concurrently, capped by
`--max-concurrent-agents`; initialization releases its slot before the participant
starts editing. This prevents a cold-start burst without lowering the live process
limit. The round-pool policy records the initialization bound. Native IDE
instructions, tools and language services remain on.

Export and inspection accept terminal runs only. They recompute scores from stage
evidence, preserve the full planned denominator and do not publish anything.
Public difference identities are hashes rather than source paths or hunk text.
Native usage cost is an SDK estimate, not a billing receipt. Observed native
concurrency is a kernel-sampled lower bound, reported separately from the pool cap.
Public execution counts distinguish registered participants from closed startup
attempts that never registered. No native identity is invented for those attempts.
The public restoration summary retains the completed restoration count and final
trusted identity. Measuring every round does not make a restoration failure a
completed result.

## What is measured

The measured object is the shared project at each round boundary. Original task
identifiers and the identity of the agent that performed an edit do not establish
credit. The scripted reference demonstrates the original workload's feasibility
under its recorded schedule; it is not proof of arbitrary parallel schedules.

The verifier creates the same deterministic canonical representation of the
trusted round start, trusted round end and measured candidate. It compares the
expected and actual changes from the same trusted start. The scoring unit is a
hunk under one pinned diff algorithm and configuration, not an original atom or
an inferred semantic edit. Different hunk sizes are an accepted property of this
metric.

Full function and method bodies participate in comparison. There is no separate
preservation veto that zeros a round for changes outside an assigned footprint.
Unexpected changes are disagreements in the same canonical-diff comparison.

## Canonical representation

Canonicalization changes only the representation used for comparison. It never
rewrites, repairs or replaces the measured working files.

- Keep project-relative file identity, lexical scopes and nesting.
- Sort the placement of structural definition blocks by deterministic keys within
  the appropriate container. Function, method and class placement can normalize;
  their bodies are retained.
- Preserve parameter order, signatures, statement order, expression operand order,
  literals and other content inside definitions. Member layout and preprocessor
  boundaries must not be accidentally erased by moving sortable blocks.
- Remove comments and normalize insignificant formatting using a parser, not
  unrestricted text replacement. Preserve whitespace that belongs to literals.
  Macro replacement lists retain preprocessing-token separation; comments and
  whitespace width normalize to one separator. Calls to macros defined in project
  sources retain the same per-argument information, including definitions from
  other project headers. Ordinary function-call layout still normalizes. The
  parser does not discover macro definitions in external system headers.
- Exclude parser memory addresses, source offsets and absolute machine paths.
- Record recoverable syntax errors explicitly. A parser crash, missing dependency
  or broken analyzer configuration is an infrastructure failure, not evidence of
  model damage. A malformed candidate is a measured input, not a reason to heal
  its source before comparison.

Serialization `ordered-cpp-source-v4` contains sorted, normalized C++ source,
not a JSON dump of parser nodes. The parser selects definition ordering; all
source tokens, complete bodies and literal bytes remain in the output. Statements
and block boundaries have deterministic whitespace. Function-like macro names
remain adjacent to their parameter lists, and significant macro token gaps remain
intact. Syntax diagnostics stay separate and explicit. Physical non-source entries
and malformed byte contents retain their lossless encodings.

Project snapshot v2 identifies this representation. Earlier CST snapshots, caches
and hunk denominators are not interchangeable: prepare a new cache from retained
proof-bound source endpoints. Do not replay edits, rescore historical observations,
or discard bodies to reduce the diff.

The initial implementation uses a pinned C++ grammar and parser. Other project
file kinds need explicit, deterministic handling; unsupported content must never
silently disappear from the snapshot. Parser and canonicalizer identity are part
of preparation and result identity.

## Hunk comparison

Both diffs use the same canonical round-start text. Pin the diff implementation,
context size, file ordering, newline policy and hunk matching rules. Diff metadata
must not incorporate temporary paths or incidental absolute output line offsets.

An unchanged candidate must miss every required reference hunk. An exact canonical
endpoint must have no disagreements. An unexpected independent actual hunk adds a
disagreement. A wrong replacement of a reference hunk must not automatically count
as both a missing expected edit and an unrelated extra edit.

Use deterministic baseline-range association for mismatching hunks, without
matching original tasks or reasoning about agent intent. Hunk grouping remains
part of the pinned metric. Empty expected round diffs require an explicit
preparation diagnosis; do not invent a denominator or award free credit.

Exact endpoint comparisons can reuse a process-local receipt minted by the pinned
diff computation. A serialized checksum cannot mint that receipt. Cache loading
still recompiles and compares every stored hunk before reuse; other candidate
changes take the ordinary diff path.
Precompute trusted canonical endpoints and reference diffs once. Parse each new
measured candidate without regenerating the trusted workload or a full reference
execution.

## Agent instructions

Structured operations and scoring records stay inside the controller. Original
assignments are rendered from operations at delivery, including when preparation
contains older cached prompt text. Agents receive imperative editing instructions:
which file to change, which complete declaration or binding to select, what to
move or rename, and which includes and directives to retain. Namespace, owner,
signature, occurrence and placement constraints remain complete. There are no
JSON target tables or serialized selector records in these instructions.

## Structural correction feedback

The expected and actual changes are diffs from the same trusted round start.
For each file with disagreements, compare those two complete diffs, including
already matching hunks. Each resulting diff-of-diffs hunk is one correction
assignment. The outer minus and plus lines represent actual and expected diff
lines; the inner markers represent changes relative to the shared round start.
The assignment names the project-relative file and gives the complete hunk. Its
coordinates refer to the serialized diffs, not physical source line numbers.
The agent locates and edits the source; the controller does not reconstruct a
physical replacement, match definition owners, or apply a canonical patch.
Scoring retains its original disagreement identities and hunk denominator.

Assignments of at most 4096 UTF-8 bytes are sent inline; larger assignments are
stored in full in a participant's read-only `/feedback/*.txt` file outside the
candidate workspace. Earlier files remain available while the session is reused.
Hunks are not truncated.

### Experimental CST correction backend

The private run configuration accepts `cppCorrectionCommand`, an argument array
whose first element is an absolute executable path. The same option is available
to `runCanonical` callers. It opts regular UTF-8 C++ source/header disagreements
into an external Mergiraf 0.20.0 correspondence helper. The setting is not passed
to participant processes. Without it, the diff-of-diffs backend remains in use.

This requires a separately built instrumented helper, **not** the ordinary
`mergiraf` merge CLI. The helper is not bundled or installed by this repository.
Mergiraf's GPL-3.0-only license, internal matching API and runtime distribution
need separate consideration before adopting or distributing that helper.

For each supported file, the controller writes immutable copies of the common
start, captured actual and trusted expected sources outside the candidate. It
invokes the configured command without a shell, appending these four arguments:

```text
BASE.cpp ACTUAL.cpp EXPECTED.cpp NEW_OUTPUT_DIRECTORY
```

The helper must create `probe.ndjson` in that new directory using the
`lpt944-mergiraf-pcs-probe-v1` protocol. Its header identifies Mergiraf `0.20.0`,
roles `B`/`A`/`E`, `recoveryPolicy: opaque-cst-regions` and `mergeExecuted: false`.
Records carry all three original sources; occurrence-specific native nodes and
class leaders; ordered children, fields, leaf text and UTF-8 byte spans; direct
matchings; ordered parent-child-successor triples; directed actual-to-expected
triple additions/removals and value updates; retained parser diagnostics; and a
complete summary with inventory/delta counts. A successful process exit alone is
not sufficient. The controller independently checks source identity, node and
matching uniqueness, spans, all ordered relations, and complete directed AST
reconstruction. Parse recovery must retain diagnostics and opaque source regions.
Timeout, cancellation, invalid output or failed reconstruction aborts preparation;
there is no silent fallback after a supported file's helper fails.

The controller aligns proven unchanged CST subtrees before comparing source gaps.
Assignments contain the full changed source fragments, surrounding context and
occurrence-specific locations for preserved code. Unchanged-subtree labels are
instructions to preserve existing code, not text to insert. Gaps participating in
the same subtree move belong to one assignment. The controller does not apply
these changes to the candidate. Correction agents still edit the shared project;
scoring, native-process closure and independent integration checks are unchanged.

Absent files, physical entries, byte-path filenames, non-C++ files and invalid
UTF-8 endpoints retain the existing diff-of-diffs backend. The private
`structural-feedback/report.json` names each file's chosen backend. Native output,
executable/input hashes, diagnostics, validated plans and complete assignments
remain in that private evidence directory. Do not publish those files as results.

### Diagnostic start at a later round

`run-canonical --from-round N` (or the `runCanonical` option `fromRound`) starts
with the exact trusted endpoint of round `N - 1` and runs the remaining rounds.
It creates fresh participant histories; it does not resume a frozen in-flight
candidate or import earlier results. A start after round one is explicitly marked
`diagnostic-continuation` and cannot be exported as a measured observation. The
full original plan and denominator remain intact: skipped rounds receive no
credit in the diagnostic partial aggregate. Per-round grading and all correction,
closure and integration checks remain unchanged. The default still runs all rounds.

## Execution and correction budgets

Each round uses a work-conserving pool, bounded by the configured native-process
limit. Dispatch ready dependency-respecting work in configurable packets, initially
10 original edits. A process receives successive packets and retains its history
while it has immediately available work. Do not grade packets individually.

When a process has finished and has no further ready assignment, terminate its
whole owned PID namespace immediately. Do not leave idle model processes alive
while another process finishes or while grading starts. A later assignment can
start a new process under the same live cap. All participants must be confirmed
closed before candidate capture, compilation, rendering or trusted restoration.
Harnesses may run their own subprocesses during work; there is no executable-name
allowlist or general descendant prohibition.

Assignments state that other agents share the project without revealing team
counts. Agents must preserve concurrent work and stay within their assignment.
Original and structural-correction agents avoid project-wide builds and lint runs;
integration-correction agents may run the supplied validation command. Native IDE
tools, instructions and diagnostic services remain enabled.

After original work:

1. Capture and canonicalize the shared candidate. Compare its actual diff with the
   reference diff and retain the independent first-pass evidence.
2. If disagreements exist, turn them into correction tasks, batch them and give
   one structural correction pass to a new pool. The original executor is not
   relevant. Close the pool and compare the complete candidate again.
3. Build the actual candidate. Discover translation units from its complete
   captured physical inventory, including malformed UTF-8 contents, byte-path
   filenames and source symlinks. Preserve inert FIFO/socket entry types in the
   private mirror without opening them. Unrepresentable unsafe types are verifier
   failures, not omitted files. A failed build permits one build-correction pass.
   Close that pool and build again.
4. If the build permits rendering, compare the repeated scene outputs. A mismatch
   permits one image-correction pass. Close that pool, rebuild and compare again.

There are at most four editing waves: original, structural correction, build
correction and image correction. Successful stages do not trigger a correction.
Transient transport failures first use the harness's bounded native recovery.
Controller-managed recovery requires Pi 1.4 or newer. An exhausted retryable
failure holds the current delivery at the native pre-settlement boundary. The controller pauses new deliveries for
a shared 60-second cooldown, then releases one held session as a probe. Other
in-flight participants may finish; they are not cancelled. A successful probe
reopens admission. Another exhausted failure starts another cooldown. There is
no automatic recovery deadline; explicit cancellation still closes every owned
process.

Recovery continues the same native run, process and conversation. Native context
edits omit only the failed response and its paired tool results from future
model context, retaining raw history and earlier completed tool effects/results.
Do not redeliver the assignment, add a user message, start a fresh process or
reset the shared project. Preserve failed native retry events and distinct
controller wait, release and completion events. Recovery does not consume an
editing wave or benchmark correction.

Native IDE diagnostics and background-terminal notifications may start another
native run after an assignment settles. Keep those runs enabled, including their
automatic native compaction. Recovery belongs
to the session, including native activity between deliveries. A terminal provider
failure in that activity stops admission under the same policy.

If a new assignment is rejected by the native busy preflight, it has not entered
the conversation. Wait for a private native-idle notification, then submit that
unaccepted assignment. Do not queue it into the existing run or replay an accepted
assignment. The idle-control RPC is acknowledged immediately; waiting for native
activity does not extend the RPC acknowledgement timeout. Only settlement after
the assignment's own acceptance can complete its delivery. Record admission waits
separately from provider recovery and benchmark corrections.

Admission failures retain their shared cause, not another session's execution
receipt. A delivery that never reaches native execution must not claim native
calls or effects.

Authentication, exhausted quota and other nonretryable failures do not enter
controller recovery. Record the failed delivery without completing its graph
nodes. Stop new deliveries and held recovery probes, but let healthy in-flight
work finish without cancellation, then report the wave failure. Pending work
and failed prerequisites remain uncompleted. Explicit cancellation and controller,
integrity or shutdown failures still stop and clean up the pool. None of these
failures authorizes a fresh benchmark attempt, provider fallback or extra
correction.

Build and image correction feedback identifies the failed stage and tells the
agent to run `bash /feedback/check-build.sh` or `bash /feedback/check-images.sh`
from the project root. The complete script is created immediately before delivery
in that session's read-only feedback directory, not in the candidate project.
It is not embedded in the prompt or created for stages the session was not assigned.
The build script discovers the current translation units and uses the verifier's
compiler flags. The image script also renders both scenes twice and compares the
resulting pixel hashes against the two expected hashes. It exposes those hashes,
not the reference pixels or source. The controller still performs independent
verification after the correction wave.

Every later code-changing pass also produces a canonical comparison. Newly
introduced structural disagreements incur penalties without opening another
structural correction budget. A later repair cannot retain credit by destroying
previously correct structure. Repeated observation of an unchanged disagreement
alone must not create repeated penalties.

## Score

Let `N` be the number of reference hunks and `D0` the number of reference hunks
that are missing or wrong, plus independent unexpected actual hunks. The raw
initial balance is `N - D0`.

For the one structural correction pass, add `0.5` for each supplied disagreement
resolved, subtract `1` for each supplied disagreement still unresolved, and
subtract `1` for each newly introduced disagreement. Later integration repairs
also subtract for newly introduced structural disagreements. Preserve the raw
balance and its ledger; clamp only each reported normalized score to `[0, 1]`.
For example, 10 expected hunks with 3 initial disagreements have a first balance
of 7; fixing all 3 produces 8.5, or 85%, before integration factors.

Build and image factors are independently:

| Outcome                                    | Factor |
| ------------------------------------------ | -----: |
| Passes without a correction for that stage |      1 |
| Passes after the single allowed correction |   0.75 |
| Still fails                                |    0.5 |

If the final candidate does not build, its image factor is `0.5` because image
matching cannot be established. A later change that breaks the build cannot keep
an earlier successful build factor. Rendering infrastructure failure must not be
reported as a measured pixel mismatch.

```text
round Score = normalized structural balance * build factor * image factor
run Score = 100 * sum(round Scores) / full planned round count
```

Keep first-pass, structural-correction and final evidence separately. Unobserved
rounds remain in the planned denominator. An interrupted run is not a completed
model result. Duration, actual native concurrency, inference usage and correction
counts remain separately reported observations.
