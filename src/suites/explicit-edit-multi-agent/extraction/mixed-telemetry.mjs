import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { hostMemorySummary, memwatchSummary } from "./mixed-host-memory.mjs";

const counters = ["turns", "toolCalls", "toolErrors", "guideReads", "input", "cacheRead", "output"];
const tokenFields = ["input", "cacheRead", "output"];
const errorPatterns = [
  ["script-error", /^Script failed\b|^Script error:/i],
  [
    "stale-selection",
    /(?:result target|search anchor) is stale|expired after its snapshot changed|move blocked: (?:start|end|targetStart|targetEnd) anchor .* is stale/i,
  ],
  ["incomplete-selection", /Incomplete result targets/i],
  ["no-matches", /search anchor has no matches/i],
  ["expired-reference", /Result reference expired or unknown/i],
  ["document-changed", /document was modified|changed after its last text transaction/i],
  ["move-anchor", /move blocked: (?:start|end|targetStart|targetEnd) anchor/i],
  ["ambiguous-symbol", /is declared \d+ times/i],
  ["cancelled", /operation was aborted|\bcancelled\b/i],
  ["invalid-request", /\bINVALID_REQUEST\b/i],
];

function errorKind(event) {
  const message = (event.result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .replace(/<system-result[\s\S]*?<\/system-result>\s*/g, "")
    .trimStart();
  return errorPatterns.find(([, pattern]) => pattern.test(message))?.[0] ?? "other";
}

const count = (map, key, amount = 1) => (map[key] = (map[key] ?? 0) + amount);
const sorted = (map, fn) =>
  Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((key) => [key, fn(map[key])]),
  );
const makeActivity = () => ({
  ...Object.fromEntries(counters.map((key) => [key, 0])),
  callsByTool: Object.create(null),
  errorsByToolAndKind: Object.create(null),
  readsByGuide: Object.create(null),
});

function addEvent(activity, event) {
  const usage = event.message?.usage;
  if (
    event.type === "message_end" &&
    event.message?.role === "assistant" &&
    usage?.totalTokens > 0
  ) {
    activity.turns++;
    for (const key of tokenFields)
      activity[key] =
        activity[key] !== null && Number.isFinite(usage[key]) ? activity[key] + usage[key] : null;
  }
  if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
    activity.toolCalls++;
    count(activity.callsByTool, event.toolName);
    if (event.isError) {
      activity.toolErrors++;
      const kinds = (activity.errorsByToolAndKind[event.toolName] ??= Object.create(null));
      count(kinds, errorKind(event));
    }
  }
  if (event.type === "tool_execution_start" && event.toolName === "read") {
    const paths = [event.args?.path].flat();
    const guides = paths.filter(
      (source) => typeof source === "string" && source.startsWith("docs:"),
    );
    if (guides.length) activity.guideReads++;
    for (const guide of guides) count(activity.readsByGuide, guide);
  }
}

async function scoreEvents(file) {
  const handle = await open(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!handle) return null;
  const activity = makeActivity();
  let seen = false;
  let parseFailure;
  try {
    for await (const line of handle.readLines()) {
      if (!line.trim()) continue;
      if (parseFailure) throw parseFailure;
      let event;
      try {
        event = JSON.parse(line);
      } catch (cause) {
        // A terminated process can leave a partial final record. Earlier corruption isn't a prefix.
        parseFailure = new Error(`Malformed Pi event in ${file}`, { cause });
        continue;
      }
      seen = true;
      addEvent(activity, event);
    }
  } finally {
    await handle.close();
  }
  return seen ? projectActivity(activity, 1) : null;
}

function projectActivity(activity, denominator) {
  const average = (value) => (value === null ? null : value / denominator);
  return {
    ...Object.fromEntries(counters.map((key) => [key, average(activity[key])])),
    callsByTool: sorted(activity.callsByTool, average),
    errorsByToolAndKind: sorted(activity.errorsByToolAndKind, (kinds) => sorted(kinds, average)),
    readsByGuide: sorted(activity.readsByGuide, average),
  };
}

/** Mixed policy starts a fresh session for each delivery, including timeouts. */
export async function mixedBehavior(directory, rows) {
  const deliveries = [];
  const sums = makeActivity();
  let deliveriesWithEvents = 0;
  for (const { id, session, status } of rows) {
    const activity = Number.isSafeInteger(session)
      ? await scoreEvents(path.join(directory, "mixed", `session-${session}-events.jsonl`))
      : null;
    deliveries.push({ id, session, status, activity });
    if (!activity) continue;
    deliveriesWithEvents++;
    for (const key of counters)
      sums[key] = sums[key] === null || activity[key] === null ? null : sums[key] + activity[key];
    for (const key of ["callsByTool", "readsByGuide"])
      for (const [name, value] of Object.entries(activity[key])) count(sums[key], name, value);
    for (const [tool, errors] of Object.entries(activity.errorsByToolAndKind)) {
      const kinds = (sums.errorsByToolAndKind[tool] ??= Object.create(null));
      for (const [kind, value] of Object.entries(errors)) count(kinds, kind, value);
    }
  }
  return {
    deliveries,
    deliveriesWithEvents,
    totals: deliveriesWithEvents ? projectActivity(sums, 1) : null,
    perDelivery: deliveriesWithEvents ? projectActivity(sums, deliveriesWithEvents) : null,
  };
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

export async function rescoreMixedRun(directory, { memoryLog } = {}) {
  const summary = await readJson(path.join(directory, "summary.json"));
  const report = await readJson(path.join(directory, "report.json"));
  const rows = report.deliveries.filter((row) => row.phase === "mixed");
  return {
    ...summary,
    hostMemory: memoryLog
      ? memwatchSummary(await readFile(memoryLog, "utf8"))
      : (summary.hostMemory ?? hostMemorySummary([])),
    behavior: await mixedBehavior(directory, rows),
  };
}

export async function compareMixedRuns(paths) {
  const columns = [];
  for (const input of paths) {
    const directory = (await stat(input)).isDirectory();
    const summary = await readJson(directory ? path.join(input, "summary.json") : input);
    columns.push(directory && !summary.behavior ? await rescoreMixedRun(input) : summary);
  }
  const rows = [["Metric", ...paths.map((_, i) => String(i + 1))]];
  const format = (x) =>
    x == null ? "unknown" : typeof x === "number" ? String(Number(x.toFixed(2))) : String(x);
  const add = (name, get) => rows.push([name, ...columns.map((s) => format(get(s)))]);
  add("Agents", (s) => s.identity?.agents);
  add("Sandbox", (s) => s.sandbox);
  add("Deliveries", (s) => s.deliveries);
  add("Timed out", (s) => s.timedOut);
  add("Failed deliveries", (s) => s.failedDeliveries?.length);
  add("Checks passed", (s) => s.checks?.all && `${s.checks.all.passed}/${s.checks.all.total}`);
  add("Verdict", (s) => s.verdict);
  add("Integrity", (s) =>
    s.checks?.integrity ? (s.checks.integrity.passed ? "pass" : "fail") : null,
  );
  add("Collateral lines", (s) => s.checks?.integrity?.affectedLines);
  add("Minutes", (s) => s.minutes);
  add("Peak process-tree RSS (MiB)", (s) => s.peakMemory?.megabytes);
  add("Min available host memory (MiB)", (s) => s.hostMemory?.minAvailableMiB);
  add("Peak swap growth (MiB)", (s) => s.hostMemory?.swapGrowthMiB);
  add("OOM kills (host)", (s) => s.hostMemory?.oomKills);
  add("Deliveries with Pi events", (s) => s.behavior?.deliveriesWithEvents);
  for (const [name, key] of [
    ["Model turns", "turns"],
    ["Tool calls", "toolCalls"],
    ["Tool errors", "toolErrors"],
    ["Guide reads", "guideReads"],
    ["Uncached input tokens", "input"],
    ["Cache-read input tokens", "cacheRead"],
    ["Output tokens", "output"],
  ])
    add(`${name}/delivery`, (s) => s.behavior?.perDelivery?.[key]);
  const means = columns.flatMap((s) => s.behavior?.perDelivery ?? []);
  const keys = (maps) => [...new Set(maps.flatMap((map) => Object.keys(map ?? {})))].sort();
  const addMean = (name, get) =>
    add(name, (s) => (s.behavior?.perDelivery ? (get(s.behavior.perDelivery) ?? 0) : null));
  for (const tool of keys(means.map((m) => m.callsByTool)))
    addMean(`Tool calls/delivery: ${tool}`, (m) => m.callsByTool[tool]);
  for (const tool of keys(means.map((m) => m.errorsByToolAndKind)))
    for (const kind of keys(means.map((m) => m.errorsByToolAndKind[tool])))
      addMean(
        `Tool errors/delivery: ${tool} / ${kind}`,
        (m) => m.errorsByToolAndKind[tool]?.[kind],
      );
  for (const guide of keys(means.map((m) => m.readsByGuide)))
    addMean(`Guide paths/delivery: ${guide}`, (m) => m.readsByGuide[guide]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return [
    ...paths.map((input, i) => `${i + 1}: ${input}`),
    "",
    ...rows.map((row) =>
      row
        .map((value, i) => (i === 0 ? value.padEnd(widths[i]) : value.padStart(widths[i])))
        .join("  "),
    ),
  ].join("\n");
}
