# Canonical-diff round scoring

This methodology is under implementation. It is separate from accepted-prefix and
restoring atom-score observations. Historical evidence, proofs and scores retain
their original interpretation.

Run version `renderer-canonical-run-v3` scores line differences against each
round's trusted endpoint with the same schedule and Score as two-phase assembly;
see [Line difference score](structural-unit-score.md). Version 2 runs counted
structural units. Version 1 runs scored canonical text hunks; the hunk sections below describe that historical policy and its export.

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
node scripts/multi-agent.mjs verify-canonical PREPARATION NEW_REFERENCE --canonical NEW_CACHE --agents 15 --batch-size 10
node scripts/multi-agent.mjs run-canonical PREPARATION NEW_OUTPUT --canonical NEW_CACHE --proof NEW_REFERENCE/summary.json --config PRIVATE_JSON --allow-model-calls --agents 15 --batch-size 10 --max-concurrent-agents 30
node scripts/multi-agent.mjs export-canonical NEW_OUTPUT NEW_RESULT_JSON
node scripts/multi-agent.mjs validate-canonical NEW_RESULT_JSON
node scripts/multi-agent.mjs inspect-canonical NEW_OUTPUT
```

The run command spends model credit and needs separate run authorization. It
requires a passing `verify-canonical` summary from the same commit. That
model-free reference writes each round's trusted endpoint during the original
wave and must reach Score 100 without corrections; it does not re-execute the
workload's operations, whose feasibility the retained proof establishes.
Export, validation and inspection accept version 1 reports only; a version 2 run
keeps its private `report.json`. `--agents` retains the workload's
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
expected and actual changes from the same trusted start. In version 2 the scoring
unit is the smallest structural scope, such as a function, class member,
declaration or directive. In version 1 it was a hunk under one pinned diff
algorithm, whose size depended on neighbouring code.

Full function and method bodies participate in comparison. There is no separate
preservation veto that zeros a round for changes outside an assigned footprint.
Unexpected changes are disagreements in the same canonical-diff comparison.

## Canonical representation

Canonicalization changes only the representation used for comparison. It never
rewrites, repairs or replaces the measured working files.

- Keep project-relative file identity, lexical scopes and nesting.
- Sort the placement of structural definition blocks by deterministic keys within
  the appropriate container. Function, method and class placement can normalize;
  their bodies are retained. At translation-unit and namespace scope, non-sortable
  named declarations are ordering barriers, including variables and `using`
  declarations; moving a definition across one can change name lookup.
  This heuristic does not prove equivalent compiler bindings.
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

Serialization `ordered-cpp-source-v6` contains sorted, normalized C++ source,
not a JSON dump of parser nodes. Adjacent plain named namespace blocks with the same
name share a canonical scope, including when the parser reports errors inside a
namespace body. The namespace name and braces must still be structurally intact.
Separate scopes, preprocessing barriers, inline
namespaces and namespace attributes remain explicit. The parser selects definition
ordering; declaration contents, complete bodies and literal bytes remain in the output. Statements
and block boundaries have deterministic whitespace. Function-like macro names
remain adjacent to their parameter lists, and significant macro token gaps remain
intact. Syntax diagnostics stay separate and explicit. Physical non-source entries
and malformed byte contents retain their lossless encodings.

Project snapshot v4 identifies this representation. Earlier CST snapshots, caches
and hunk denominators are not interchangeable: prepare a new cache from retained
proof-bound source endpoints. Do not replay edits, rescore historical observations,
or discard bodies to reduce the diff.

The initial implementation uses a pinned C++ grammar and parser. Other project
file kinds need explicit, deterministic handling; unsupported content must never
silently disappear from the snapshot. Parser and canonicalizer identity are part
of preparation and result identity.

## Hunk comparison (version 1)

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

Version 3 correction assignments describe each differing hunk of lines in prose,
one file per assignment, as described in
[Line difference score](structural-unit-score.md). The agent locates and edits the
source; the controller does not apply a patch. Version 1 delivered diff-of-diffs
hunks as JSON and optionally used an external Mergiraf correspondence helper; both
were removed because agents must receive prose only.

Assignments of at most 4096 UTF-8 bytes are sent inline; larger assignments are
stored in full in a participant's read-only `/feedback/*.txt` file outside the
candidate workspace. Earlier files remain available while the session is reused.
Assignments are not truncated.

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

Hard provider refusals stop the observation rather than entering recovery. HTTP
401/402/403 and explicit exhausted account credit or quota errors take precedence
over a misleading `server_error` wrapper. The controller preserves completed tool
effects and the native failure receipt, stops new admissions, and closes the
failed participant before native automatic retries. Temporary throughput limits (`429`),
connection errors and transient server failures retain the existing recovery path.

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

Every delivery has a 120-second limit, the same as in chunk extraction. A
participant that exceeds it is shut down and its partial edits remain. The
packet is not retried; its dependents are released and later packets go to a
fresh participant under the same process cap.

After original work:

1. Capture the shared candidate and compare its lines with the trusted round
   endpoint. This first-pass evidence is retained.
2. If disagreements exist, turn them into per-file correction assignments and
   give one structural correction pass to a new pool. The original executor is
   not relevant. Close the pool.
3. Build the actual candidate. Discover translation units from its complete
   captured physical inventory, including malformed UTF-8 contents, byte-path
   filenames and source symlinks. Preserve inert FIFO/socket entry types in the
   private mirror without opening them. Unrepresentable unsafe types are verifier
   failures, not omitted files. A failed build permits one build-correction pass.
   Close that pool and build again.
4. If the build still fails or the repeated scene outputs differ, one
   result-correction pass follows. Close that pool.
5. Capture, compare and measure the final candidate.

There are at most four editing waves: original, structural correction, build
correction and result correction. Successful stages do not trigger a correction.
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

## Score

Version 3 rounds use the line difference Score: original and final captures,
`N - D0`, a quarter credit per resolved original difference, one point per new
difference, an unchanged difference charged once, and build and image factors.
See [Line difference score](structural-unit-score.md).

Version 1 rounds used reference hunks: `N` reference hunks, `D0` missing or wrong
hunks plus independent unexpected hunks, `+0.5` per resolved and `-1` per new
disagreement, with the same factors:

| Outcome                                    | Factor |
| ------------------------------------------ | -----: |
| Passes without a correction for that stage |      1 |
| Passes after the single allowed correction |   0.75 |
| Still fails                                |    0.5 |

```text
round Score = normalized structural balance * build factor * image factor
run Score = 100 * sum(round Scores) / full planned round count
```

Unobserved rounds remain in the planned denominator. An interrupted run is not a
completed model result. Duration, actual native concurrency, inference usage and
correction counts remain separately reported observations.
