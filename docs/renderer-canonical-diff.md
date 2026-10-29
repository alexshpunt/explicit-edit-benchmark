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
lifetime override. Native IDE instructions, tools and language services remain on.

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

## Structural correction feedback

Scoring disagreements and correction assignments are separate units. Feedback
`canonical-diff-of-diffs-v1` takes a second ordinary diff, in the direction
**actual changes to expected changes**, with the same pinned implementation and
three context lines. Each hunk of that second diff is one correction assignment;
the scoring ledger keeps its original disagreement identities.

For each affected file, serialize its complete actual and expected canonical
deltas, including already-matching hunks. Each original hunk contributes a JSON
header `["hunk", oldStart, oldLines, newLines]`, then its complete patch lines,
with LF separators. Exclude output offsets and controller IDs. Compare the two
serialized deltas once per file; do not repeat an entire associated hunk for each
disagreement or compare an isolated expected fragment against a spanning actual
hunk. Either shortcut can repeat large amounts of correct content or ask an agent
to undo correct changes.

The assignment carries the physical file location, related scoring disagreements,
and one second-diff hunk. Its outer minus/plus markers describe actual-to-expected
differences; its inner markers describe baseline-to-candidate/reference changes.
Second-diff line numbers address the serialized change text, not C++ source lines.
These records locate edits in real source; they are not a C++ patch. Filename
bytes remain lossless, including non-UTF-8 paths.

A second diff removes matching content, not missing content. A completely absent
large addition still requires its complete expected delta. Neither this feedback
contract nor engineering integration checks establish that every correction
packet fits a particular model's context window. Do not truncate required changes,
silently split the configured packet, or claim model readiness from a small fixture.

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
Auth, provider, cancellation and infrastructure failures remain separate stops;
they do not authorize a model retry, fallback or an extra correction.

Build and image correction feedback identifies the failed stage and supplies a
Bash validation command; it does not repeat task prompts or compiler diagnostics.
The build command discovers the current translation units and uses the verifier's
compiler flags. The image command also renders both scenes twice and compares the
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
