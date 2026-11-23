import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TRACE_FORMAT, type PackedTrace, type TraceEvent, type TraceHeader } from "./types.ts";

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** Writes a trace directory. Blobs are given as text and stored by their sha256. */
export async function writeTrace(
  directory: string,
  header: TraceHeader,
  events: TraceEvent[],
  blobs: Map<string, string>,
) {
  validateTrace(header, events, blobs);
  await mkdir(path.join(directory, "blobs"), { recursive: true });
  await writeFile(path.join(directory, "trace.json"), JSON.stringify(header, null, 2) + "\n");
  await writeFile(
    path.join(directory, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  for (const [hash, text] of blobs)
    await writeFile(path.join(directory, "blobs", `${hash}.txt`), text);
}

export async function readTrace(directory: string) {
  const header = JSON.parse(
    await readFile(path.join(directory, "trace.json"), "utf8"),
  ) as TraceHeader;
  const events = (await readFile(path.join(directory, "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
  const blobs = new Map<string, string>();
  for (const file of header.files)
    blobs.set(
      file.initial.blob,
      await readFile(path.join(directory, "blobs", `${file.initial.blob}.txt`), "utf8"),
    );
  validateTrace(header, events, blobs);
  return { header, events, blobs };
}

export async function packTrace(directory: string): Promise<PackedTrace> {
  const { header, events, blobs } = await readTrace(directory);
  return { header, events, blobs: Object.fromEntries(blobs) };
}

/** Throws on a trace the viewer could not replay. */
export function validateTrace(
  header: TraceHeader,
  events: TraceEvent[],
  blobs: Map<string, string>,
) {
  const fail = (message: string) => {
    throw new Error(`Invalid trace: ${message}`);
  };
  // The file on disk may hold any format, whatever the type says.
  const format: string = header.format;
  if (format !== TRACE_FORMAT) fail(`format ${format}`);
  const agents = new Set(header.agents.map((agent) => agent.id));
  if (agents.size !== header.agents.length) fail("duplicate agent id");
  const lines = new Map<string, number>();
  for (const file of header.files) {
    const text = blobs.get(file.initial.blob);
    if (text === undefined) fail(`missing initial blob of ${file.path}`);
    else if (sha256(text) !== file.initial.blob) fail(`blob hash of ${file.path}`);
    lines.set(file.id, splitLines(text ?? "").length);
  }
  const calls = new Map<string, string>();
  let last = -Infinity;
  let seq = -1;
  const versions = new Map<string, number>();
  for (const event of events) {
    if (!(event.t >= last)) fail(`event ${event.seq} goes back in time`);
    if (!(event.seq > seq)) fail(`event seq ${event.seq} is not increasing`);
    last = event.t;
    seq = event.seq;
    if ("agent" in event && !agents.has(event.agent)) fail(`unknown agent ${event.agent}`);
    if (event.kind === "call.start") {
      if (calls.has(event.call)) fail(`duplicate call ${event.call}`);
      calls.set(event.call, event.agent);
    }
    if (
      (event.kind === "call.end" || event.kind === "observe") &&
      calls.get(event.call) !== event.agent
    )
      fail(`${event.kind} of unknown call ${event.call}`);
    if (event.kind === "file.change") {
      const count = lines.get(event.file);
      if (count === undefined) fail(`change of unknown file ${event.file}`);
      const version = (versions.get(event.file) ?? 0) + 1;
      if (event.version !== version)
        fail(`file ${event.file} version ${event.version} != ${version}`);
      versions.set(event.file, version);
      let total = count ?? 0;
      let floor = 0;
      for (const hunk of event.hunks) {
        if (hunk.at < floor || hunk.removed.length !== hunk.remove)
          fail(`bad hunk in ${event.seq}`);
        floor = hunk.at + hunk.remove;
        total += hunk.insert.length - hunk.remove;
        if (hunk.cause.agent !== undefined && !agents.has(hunk.cause.agent))
          fail(`hunk cause agent ${hunk.cause.agent}`);
      }
      if (floor > (count ?? 0) || total !== event.lines) fail(`line count of change ${event.seq}`);
      lines.set(event.file, total);
    }
  }
}

/** Lines without their terminators. A trailing newline does not add an empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
