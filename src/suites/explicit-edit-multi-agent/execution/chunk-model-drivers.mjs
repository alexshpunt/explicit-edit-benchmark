import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { finalizedUsage, startPiParticipant } from "./pi-baseline.mjs";
import { admitProviderDelivery, createProviderRecovery } from "./provider-recovery.mjs";
import { executeChunkDelivery } from "./chunk-delivery-deadline.mjs";
import { isOmpParticipant, startOmpParticipant } from "./omp-participant.mjs";
import { isDiracParticipant, startDiracParticipant } from "./dirac-participant.mjs";

export const CHUNK_PROVIDER_RETRY_LIMIT = 3;

/** Isolated native Pi participants for chunk teams. Provider cooldown happens before
 * the delivery deadline starts; the general instructions precede a session's first
 * assignment only. With sharedSandbox, a function that resolves to the started team
 * sandbox, every participant joins that sandbox. onEvent(session, event) observes a
 * native Pi participant's events as they arrive; `observesEvents` tells whether the
 * configured participants report them.
 */
export function chunkModelDrivers(
  output,
  workspace,
  config,
  generalPrompt,
  { sharedSandbox, onEvent } = {},
) {
  assert.equal(typeof generalPrompt, "string");
  assert.ok(onEvent === undefined || typeof onEvent === "function");
  const states = new Map(),
    retries = new Map(),
    started = new Set();
  const recovery = createProviderRecovery({
    onEvent: (event) =>
      appendFileSync(path.join(output, "provider-events.jsonl"), JSON.stringify(event) + "\n", {
        mode: 0o600,
      }),
  });
  return {
    observesEvents: !isOmpParticipant(config) && !isDiracParticipant(config),
    usage: (driver) => finalizedUsage(driver.events),
    /** Forget a closed participant, so that its event trace can be freed; cleanup
     * still clears its retained credentials.
     */
    release(driver) {
      assert.equal(driver?.closed, true, "Release of an open participant");
      for (const [state, own] of states) if (own === driver) states.set(state, { closed: true });
    },
    async createDriver(_agent, session, { signal }) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      const state = path.join(output, `session-${session}`);
      states.set(state, null);
      retries.set(session, 0);
      const sandbox = sharedSandbox ? await sharedSandbox() : undefined;
      if (isOmpParticipant(config) || isDiracParticipant(config)) {
        // One process per delivery; native Pi's recovery protocol does not apply.
        const start = isOmpParticipant(config) ? startOmpParticipant : startDiracParticipant;
        const driver = await start(workspace, state, config, {
          signal,
          eventsFile: state + "-events.jsonl",
          sharedSandbox: sandbox,
          onProviderFailure: (error) => recovery.stop(error),
        });
        states.set(state, driver);
        return driver;
      }
      const driver = await startPiParticipant(workspace, state, config, {
        signal,
        eventsFile: state + "-events.jsonl",
        enforceProcessBoundary: !sandbox,
        sharedSandbox: sandbox,
        disableAutoRetry: true,
        onRecovery: (request) => {
          const count = retries.get(session) + 1;
          retries.set(session, count);
          if (count > CHUNK_PROVIDER_RETRY_LIMIT) throw new Error("Provider retry limit reached");
          return recovery.wait(request);
        },
        onProviderFailure: (error) => recovery.stop(error),
        onEvent: onEvent && ((event) => onEvent(session, event)),
      });
      states.set(state, driver);
      return driver;
    },
    async execute(driver, assignment, { signal, session, retire, timeoutMs }) {
      await admitProviderDelivery(recovery, { signal });
      retries.set(session, 0);
      const prompt =
        (started.has(session) || !generalPrompt ? "" : generalPrompt + "\n\n") + assignment;
      started.add(session);
      return executeChunkDelivery(driver, prompt, { signal, retire, timeoutMs });
    },
    /** Private provider credentials never remain in retained participant state. */
    async cleanup() {
      assert.ok(
        [...states.values()].every((driver) => driver?.closed === true),
        "Unconfirmed participant closure",
      );
      for (const state of states.keys()) {
        for (const [subdirectory, files] of [
          ["pi", ["auth.json", "models.json"]],
          ["omp", ["agent.db", "agent.db-wal", "agent.db-shm"]],
          ["dirac/data", ["secrets.json"]],
        ]) {
          const directory = path.join(state, subdirectory);
          const entry = await lstat(directory).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (!entry) continue;
          assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
          await Promise.all(files.map((file) => rm(path.join(directory, file), { force: true })));
        }
      }
    },
  };
}
