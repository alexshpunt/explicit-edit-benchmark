import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { sha256 } from "./trace/store.ts";

const compress = promisify(gzip);

/**
 * Harness-independent recorder. It runs beside the agents and writes:
 *
 *   versions.jsonl  {t, file, sha256, bytes} for every distinct content of a watched file
 *   blobs/<sha256>.gz
 *   streams.jsonl   {t, file, size} whenever a stream file (an append-only log) grows
 *
 * Times are Date.now() milliseconds, the clock Pi and most harnesses use for their own
 * timestamps. Watched files are polled by stat and checked again on every fs.watch event
 * of their directory, so atomic renames and in-place writes are both seen. Two writes
 * closer than one poll can merge into one version; attribution works per hunk for that.
 */
export interface RecorderOptions {
  out: string;
  /** Absolute paths of watched files. They may not exist yet. */
  files: string[];
  /** Directories whose matching files are append-only logs to time-stamp. */
  streams?: Array<{ directory: string; pattern: RegExp }>;
  pollMs?: number;
  streamPollMs?: number;
}

export interface Recorder {
  stop(): Promise<{ versions: number; streamRecords: number }>;
}

export async function startRecorder(options: RecorderOptions): Promise<Recorder> {
  const { out, files, streams = [], pollMs = 10, streamPollMs = 40 } = options;
  await mkdir(path.join(out, "blobs"), { recursive: true });
  await writeFile(
    path.join(out, "recorder.json"),
    JSON.stringify(
      {
        started: Date.now(),
        files,
        streams: streams.map((s) => ({ directory: s.directory, pattern: s.pattern.source })),
      },
      null,
      2,
    ) + "\n",
  );
  const versionsFile = path.join(out, "versions.jsonl");
  const streamsFile = path.join(out, "streams.jsonl");
  await writeFile(versionsFile, "");
  await writeFile(streamsFile, "");

  const state = new Map<string, { key: string; hash: string }>();
  const sizes = new Map<string, number>();
  let versions = 0;
  let streamRecords = 0;
  let writes = Promise.resolve();
  // Stop awaits the chain, so a failed write surfaces there.
  const queue = (job: () => Promise<void>) => {
    writes = writes.then(job);
  };
  const written = new Set<string>();

  const checkFile = async (file: string) => {
    let info;
    try {
      info = await stat(file, { bigint: true });
    } catch {
      return;
    }
    const key = `${info.ino}:${info.size}:${info.mtimeNs}`;
    const previous = state.get(file);
    if (previous?.key === key) return;
    const t = Date.now();
    let content: Buffer;
    try {
      const handle = await open(file, "r");
      try {
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch {
      return;
    }
    const hash = sha256(content);
    state.set(file, { key, hash });
    if (previous?.hash === hash) return;
    versions++;
    queue(async () => {
      if (!written.has(hash)) {
        written.add(hash);
        await writeFile(path.join(out, "blobs", `${hash}.gz`), await compress(content));
      }
      await appendFile(
        versionsFile,
        JSON.stringify({ t, file, sha256: hash, bytes: content.length }) + "\n",
      );
    });
  };

  const checking = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const check = (file: string) => {
    if (checking.has(file)) {
      again.add(file);
      return;
    }
    const run = checkFile(file).finally(() => {
      checking.delete(file);
      if (again.delete(file)) check(file);
    });
    checking.set(file, run);
  };

  const checkStreams = async () => {
    for (const { directory, pattern } of streams) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!pattern.test(name)) continue;
        const file = path.join(directory, name);
        let size: number;
        try {
          size = (await stat(file)).size;
        } catch {
          continue;
        }
        if (sizes.get(file) === size) continue;
        sizes.set(file, size);
        streamRecords++;
        const record = JSON.stringify({ t: Date.now(), file, size }) + "\n";
        queue(() => appendFile(streamsFile, record));
      }
    }
  };

  const watchers: FSWatcher[] = [];
  const watched = new Set<string>();
  const attachWatchers = () => {
    for (const directory of new Set(files.map((file) => path.dirname(file)))) {
      if (watched.has(directory)) continue;
      try {
        watchers.push(
          watch(directory, () => {
            for (const file of files) if (path.dirname(file) === directory) check(file);
          }),
        );
        watched.add(directory);
      } catch {
        // The directory does not exist yet; polling attaches later.
      }
    }
  };

  let stopped = false;
  let streamBusy = false;
  const fileTimer = setInterval(() => {
    attachWatchers();
    for (const file of files) check(file);
  }, pollMs);
  const streamTimer = setInterval(() => {
    if (streamBusy) return;
    streamBusy = true;
    void checkStreams().finally(() => (streamBusy = false));
  }, streamPollMs);
  attachWatchers();
  for (const file of files) check(file);

  return {
    async stop() {
      if (stopped) throw new Error("Recorder already stopped");
      stopped = true;
      clearInterval(fileTimer);
      clearInterval(streamTimer);
      for (const watcher of watchers) watcher.close();
      await Promise.all(checking.values());
      for (const file of files) await checkFile(file);
      await checkStreams();
      await writes;
      return { versions, streamRecords };
    },
  };
}
