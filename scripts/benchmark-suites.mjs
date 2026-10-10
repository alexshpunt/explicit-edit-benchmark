import { explicitEditBenchmarkId } from "../src/suites/explicit-edit/version.ts";
import { MULTI_AGENT_BENCHMARK } from "../src/suites/explicit-edit-multi-agent/results.mjs";
import { approvedWorkflow } from "./official-policy.mjs";
import { suiteVerifier } from "./run-multi-agent-batch.mjs";

/** Default suite selector, taken from the original benchmark's public identity. */
export const DEFAULT_BENCHMARK_SUITE = explicitEditBenchmarkId.split("/").at(-1);

/** Resolve public scheduling before any harness or credential is accessed.
 * Multi-Agent observations always use the complete workload and 15 participants.
 * The original suite keeps its configurable concurrency and optional task filter.
 */
export function suiteRunOptions(suite = DEFAULT_BENCHMARK_SUITE, { concurrency, task } = {}) {
  if (![DEFAULT_BENCHMARK_SUITE, MULTI_AGENT_BENCHMARK].includes(suite))
    throw Error(`Unknown benchmark suite: ${suite}`);
  const multiAgent = suite === MULTI_AGENT_BENCHMARK;
  concurrency ??= multiAgent ? "15" : "10";
  if (!/^\d+$/.test(concurrency) || Number(concurrency) < 1)
    throw Error("Run concurrency must be a positive integer");
  if (multiAgent && Number(concurrency) !== 15)
    throw Error("Multi-Agent requires exactly 15 agents");
  if (multiAgent && task !== undefined)
    throw Error("Multi-Agent requires the full workload; partial task selection is not allowed");
  return { suite, concurrency };
}

/** Resolve a validated release policy before the official producer reads credentials.
 * The existing runner pin must be active; a team suite also needs an explicit
 * release record matching the loaded suite implementation. No model calls occur.
 */
export async function officialSuiteRunOptions(policy, suite, options) {
  const scope = suiteRunOptions(suite, options);
  const workflow = approvedWorkflow(policy, options.runnerSha);
  if (workflow.runnerSha !== options.runnerSha)
    throw Error("Release policy does not approve the producing runner");
  if (scope.suite === MULTI_AGENT_BENCHMARK) {
    const release = policy.suites?.[scope.suite];
    if (!release || release.runner.verifierSha256 !== (await suiteVerifier()))
      throw Error("Multi-Agent has no matching approved release policy");
  }
  return scope;
}
