import path from "node:path";
import { writeFile } from "node:fs/promises";
import {
  closeHarness,
  inspectHarnessOutput,
  recoveryAdapter,
  runHarness,
} from "./harness-runtime.mjs";

/** Bind an existing benchmark adapter to one participant's durable state.
 * Participants share only the project. Each delivery keeps its own native evidence
 * and uses the same output parser and continuation contract as ordinary trials.
 */
export function harnessParticipant(adapter, { workspace, state, artifacts }) {
  let delivered = false;
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    async execute(prompt, { signal, round, attempt }) {
      if (closed) throw Error("Harness participant is closed");
      const current = delivered
        ? adapter.driver?.persistent
          ? { ...adapter, seedFiles: {}, stateFiles: {} }
          : recoveryAdapter(adapter, true)
        : adapter;
      const directory = path.join(artifacts, `${round}-attempt-${attempt}`);
      let execution, failure;
      try {
        execution = await runHarness(current, {
          workspace,
          state,
          artifacts: directory,
          prompt,
          timeoutMs: null,
          signal,
        });
      } catch (error) {
        failure =
          error instanceof Error ? error : Error("Harness delivery failed", { cause: error });
        execution = error?.execution ?? {
          exitCode: null,
          signal: null,
          timedOut: false,
          processSeconds: null,
        };
      }
      delivered = true;
      let metrics;
      try {
        metrics = await inspectHarnessOutput(current, path.join(directory, "stdout.jsonl"));
      } catch (error) {
        // A pre-cancelled delivery has no native file and must not fabricate a receipt.
        if (failure) throw failure;
        throw error;
      }
      await writeFile(
        path.join(directory, "tool-calls.json"),
        JSON.stringify(metrics.calls ?? null) + "\n",
      );
      const { calls: _calls, errors, ...observations } = metrics;
      const receipt = {
        ...execution,
        ...observations,
        eventErrors: Array.isArray(errors) ? errors.length : null,
        toolCallsObserved: Array.isArray(metrics.calls),
      };
      await writeFile(path.join(directory, "execution.json"), JSON.stringify(receipt) + "\n");
      if (failure) {
        if (typeof failure === "object" && Object.isExtensible(failure)) {
          failure.receipt = receipt;
          if (!signal?.aborted)
            failure.category ??= metrics.providerFailure ? "provider_failure" : "driver_exit";
        }
        throw failure;
      }
      if (metrics.providerFailure || execution.exitCode !== 0) {
        const error = Error("Harness delivery did not settle successfully");
        error.category = metrics.providerFailure ? "provider_failure" : "driver_exit";
        error.receipt = receipt;
        throw error;
      }
      return receipt;
    },
    async close() {
      await closeHarness(state);
      closed = true;
    },
  };
}
