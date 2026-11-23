import { readTrace } from "./trace/store.ts";

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const tokens = (text: string) => new Set(text.match(IDENTIFIER) ?? []);

/**
 * Checks hunk attribution of a mixed-probe trace against a proxy truth: a hunk that
 * introduces an identifier named by exactly one agent's task belongs to that agent.
 * Returns, per confidence, how many such hunks there are and how many agree.
 */
export async function attributionAgreement(traceDir: string) {
  const { header, events } = await readTrace(traceDir);
  const tasks = header.agents.map((agent) => ({ id: agent.id, names: tokens(agent.task ?? "") }));
  const stats: Record<string, { checked: number; agree: number }> = {};
  for (const event of events) {
    if (event.kind !== "file.change") continue;
    for (const hunk of event.hunks) {
      const removed = tokens(hunk.removed.join("\n"));
      const fresh = [...tokens(hunk.insert.join("\n"))].filter((name) => !removed.has(name));
      const owners = tasks.filter((task) => fresh.some((name) => task.names.has(name)));
      const [owner] = owners;
      if (owners.length !== 1 || !owner) continue;
      const entry = (stats[hunk.cause.confidence] ??= { checked: 0, agree: 0 });
      entry.checked++;
      if (hunk.cause.agent === owner.id) entry.agree++;
    }
  }
  return stats;
}
