import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { finalizedUsage, startPiParticipant } from "./pi-baseline.mjs";
import { admitProviderDelivery, createProviderRecovery } from "./provider-recovery.mjs";
import { executeChunkDelivery } from "./chunk-delivery-deadline.mjs";

export const CHUNK_PROVIDER_RETRY_LIMIT = 3;

/** Isolated native Pi participants for chunk teams. Provider cooldown happens before
 * the delivery deadline starts; the general instructions precede a session's first
 * assignment only.
 */
export function chunkModelDrivers(output, workspace, config, generalPrompt) {
  assert.equal(typeof generalPrompt, "string");
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
    usage: (driver) => finalizedUsage(driver.events),
    async createDriver(_agent, session, { signal }) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      const state = path.join(output, `session-${session}`);
      states.set(state, null);
      retries.set(session, 0);
      const driver = await startPiParticipant(workspace, state, config, {
        signal,
        eventsFile: state + "-events.jsonl",
        enforceProcessBoundary: true,
        disableAutoRetry: true,
        onRecovery: (request) => {
          const count = retries.get(session) + 1;
          retries.set(session, count);
          if (count > CHUNK_PROVIDER_RETRY_LIMIT) throw new Error("Provider retry limit reached");
          return recovery.wait(request);
        },
        onProviderFailure: (error) => recovery.stop(error),
      });
      states.set(state, driver);
      return driver;
    },
    async execute(driver, assignment, { signal, session, retire }) {
      await admitProviderDelivery(recovery, { signal });
      retries.set(session, 0);
      const prompt =
        (started.has(session) || !generalPrompt ? "" : generalPrompt + "\n\n") + assignment;
      started.add(session);
      return executeChunkDelivery(driver, prompt, { signal, retire });
    },
    /** Private provider credentials never remain in retained participant state. */
    async cleanup() {
      assert.ok(
        [...states.values()].every((driver) => driver?.closed === true),
        "Unconfirmed participant closure",
      );
      for (const state of states.keys()) {
        const directory = path.join(state, "pi");
        const entry = await lstat(directory).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!entry) continue;
        assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
        await Promise.all(
          ["auth.json", "models.json"].map((file) =>
            rm(path.join(directory, file), { force: true }),
          ),
        );
      }
    },
  };
}
