import { setTimeout } from "node:timers/promises";

/** Resume a pinned snapshot in the same cache, with at most three attempts after socket failures. */
export async function downloadSnapshotWithRetry(hub, params, { wait = setTimeout } = {}) {
  if (!/^[a-f0-9]{40}$/u.test(params.revision ?? ""))
    throw Error("Snapshot retries require a pinned commit revision");
  for (let attempt = 1; ; attempt++) {
    try {
      return await hub.snapshotDownload(params);
    } catch (error) {
      const code = error.cause?.code ?? error.code;
      if (attempt === 3 || code !== "UND_ERR_SOCKET") throw error;
      console.warn(`Snapshot socket failure; resuming retained cache (attempt ${attempt + 1}/3).`);
      await wait(1000 * attempt);
    }
  }
}
