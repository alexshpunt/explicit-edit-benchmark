import { createHash } from "node:crypto";

const ROUND_METRICS = [
  "seconds",
  "costUsd",
  "totalTokens",
  "toolCallCount",
  "eventErrors",
  "failedToolCalls",
  "invalidToolCalls",
];

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stable(value))
    .digest("hex");
}

function asRuns(run) {
  return Array.isArray(run) ? run : [run];
}

function compileRuns({ run, profiles, trials, rounds, toolCalls }) {
  const runs = asRuns(run);
  const roundsByTrial = Map.groupBy(rounds, (row) => `${row.runId}\0${row.trialId}`);
  const trialByRound = new Map(
    rounds.map((row) => [`${row.runId}\0${row.roundId}`, `${row.runId}\0${row.trialId}`]),
  );
  const toolsByTrial = new Map();
  for (const call of toolCalls) {
    const trialKey = trialByRound.get(`${call.runId}\0${call.roundId}`);
    if (!trialKey || !call.tool) continue;
    const counts = toolsByTrial.get(trialKey) ?? {};
    counts[call.tool] = (counts[call.tool] ?? 0) + 1;
    toolsByTrial.set(trialKey, counts);
  }
  return runs.map((runRow) => {
    const runProfiles = profiles.filter((row) => row.runId === runRow.runId);
    const runTrials = trials.filter((row) => row.runId === runRow.runId);
    return {
      run: runRow,
      profiles: runProfiles,
      trials: runTrials.map((trial) => {
        const key = `${trial.runId}\0${trial.trialId}`;
        const trialRounds = roundsByTrial.get(key) ?? [];
        const metrics = Object.fromEntries(
          ROUND_METRICS.map((field) => {
            const observed = trialRounds.filter((row) => typeof row[field] === "number");
            return [
              field,
              {
                observations: observed.length,
                total: observed.reduce((sum, row) => sum + row[field], 0),
              },
            ];
          }),
        );
        return {
          trial,
          observedRounds: trialRounds.length,
          timeouts: trialRounds.filter((row) => row.timedOut === true).length,
          metrics,
          tools: toolsByTrial.get(key) ?? {},
        };
      }),
    };
  });
}

function stateSource(sourceIndex) {
  return {
    sha256: sha256(sourceIndex),
    submissions: sourceIndex.submissions?.length ?? 0,
  };
}

/** Build the compact, rebuildable aggregation cache from canonical normalized evidence. */
export function createAggregateState({ sourceIndex, run, profiles, trials, rounds, toolCalls }) {
  const contributions = compileRuns({ run, profiles, trials, rounds, toolCalls });
  return {
    schemaVersion: 1,
    aggregationVersion: 1,
    source: stateSource(sourceIndex),
    contributions,
  };
}

/** Fail closed when a cache does not describe the exact canonical source index. */
export function verifyAggregateState(state, sourceIndex) {
  if (
    state?.schemaVersion !== 1 ||
    state?.aggregationVersion !== 1 ||
    !Array.isArray(state.contributions)
  )
    throw Error("Unsupported aggregate state");
  const expected = stateSource(sourceIndex);
  if (
    state.source?.sha256 !== expected.sha256 ||
    state.source?.submissions !== expected.submissions
  )
    throw Error("Aggregate state does not match source index");
  const expectedRuns = sourceIndex.submissions?.map((item) => item.runId) ?? [];
  const actualRuns = state.contributions.map((item) => item.run.runId);
  if (JSON.stringify(actualRuns) !== JSON.stringify(expectedRuns))
    throw Error("Aggregate state run order does not match source index");
  return state;
}

/** Append one or more newly verified runs without reading historical normalized bundles. */
export function appendAggregateRun(
  state,
  { previousSourceIndex, sourceIndex, run, profiles, trials, rounds, toolCalls },
) {
  verifyAggregateState(state, previousSourceIndex);
  const additions = compileRuns({ run, profiles, trials, rounds, toolCalls });
  const existing = new Map(state.contributions.map((item) => [item.run.runId, sha256(item)]));
  for (const contribution of additions) {
    const digest = existing.get(contribution.run.runId);
    if (digest && digest !== sha256(contribution))
      throw Error(`Run ${contribution.run.runId} already has different evidence`);
    if (digest) continue;
    state = { ...state, contributions: [...state.contributions, contribution] };
  }
  const next = { ...state, source: stateSource(sourceIndex) };
  verifyAggregateState(next, sourceIndex);
  return next;
}

function syntheticRounds(fact) {
  const count = fact.observedRounds;
  return Array.from({ length: count }, (_, index) => {
    const row = {
      runId: fact.trial.runId,
      trialId: fact.trial.trialId,
      roundId: `aggregate-${fact.trial.trialId}-${index + 1}`,
      timedOut: index < fact.timeouts,
    };
    for (const field of ROUND_METRICS) {
      const metric = fact.metrics[field];
      row[field] = index < metric.observations ? (index === 0 ? metric.total : 0) : null;
    }
    return row;
  });
}

/** Restore the aggregation inputs without restoring old source bundles or public shards. */
export function materializeAggregateState(state) {
  if (state?.schemaVersion !== 1 || state?.aggregationVersion !== 1)
    throw Error("Unsupported aggregate state");
  const runs = state.contributions.map((item) => item.run);
  const profiles = state.contributions.flatMap((item) => item.profiles);
  const trials = state.contributions.flatMap((item) => item.trials.map((fact) => fact.trial));
  const rounds = state.contributions.flatMap((item) => item.trials.flatMap(syntheticRounds));
  const toolCalls = state.contributions.flatMap((item) =>
    item.trials.flatMap((fact) =>
      Object.entries(fact.tools).flatMap(([tool, count]) =>
        Array.from({ length: count }, (_, index) => ({
          runId: fact.trial.runId,
          roundId: `aggregate-${fact.trial.trialId}-1`,
          callId: `aggregate-${fact.trial.trialId}-${tool}-${index + 1}`,
          tool,
        })),
      ),
    ),
  );
  return { runs, profiles, trials, rounds, toolCalls };
}
