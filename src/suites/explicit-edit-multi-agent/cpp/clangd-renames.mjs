import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Keep one parsed translation unit alive for all rename requests. Each request
// sees the original document; edits are collected, not fed back into clangd.
class Client {
  constructor() {
    this.child = spawn("clangd-18", [
      "--background-index=false",
      "--enable-config=false",
      "--clang-tidy=false",
      "--log=error",
    ]);
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.next = 1;
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
    this.child.stderr.resume();
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => this.fail(new Error(`clangd exited: ${code}`)));
  }
  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1];
      if (!length) {
        this.fail(new Error("Invalid clangd message"));
        return;
      }
      const next = end + 4 + Number(length);
      if (this.buffer.length < next) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, next).toString());
      this.buffer = this.buffer.subarray(next);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }
  send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }
  request(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`clangd timed out: ${method}`));
      }, 180_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  notify(method, params) {
    this.send({ method, params });
  }
  close() {
    // This disposable server has no edits to save. SIGTERM can wait on indexing.
    this.child.kill("SIGKILL");
  }
}

/** Open one disposable compiler document. Each rename uses this unchanged snapshot.
 * The caller can deliver requests one at a time and must close the session after its batch.
 */
export async function semanticSession(sourcePath, source, flags) {
  const client = new Client();
  const uri = pathToFileURL(sourcePath).href;
  const starts = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") starts.push(index + 1);
  const offset = (position) => starts[position.line] + position.character;
  try {
    await client.request("initialize", {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions: { fallbackFlags: flags },
    });
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "cpp", version: 1, text: source },
    });
    await client.request("textDocument/documentSymbol", { textDocument: { uri } });
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    close: () => client.close(),
    async edits(selection) {
      const edits = new Map();
      for (const entry of selection) {
        const start = Buffer.from(source).subarray(0, entry.offset).toString("utf8").length;
        if (edits.get(start)?.new === entry.newName) continue;
        let line = 0;
        while (line + 1 < starts.length && starts[line + 1] <= start) line++;
        const result = await client.request("textDocument/rename", {
          textDocument: { uri },
          position: { line, character: start - starts[line] },
          newName: entry.newName,
        });
        if (!result?.changes) throw new Error(`No semantic edits for ${entry.name}`);
        for (const [changedUri, changes] of Object.entries(result.changes)) {
          if (changedUri !== uri)
            throw new Error(`Rename crosses fixed source boundary: ${entry.name}`);
          for (const change of changes) {
            const begin = offset(change.range.start),
              end = offset(change.range.end);
            const edit = {
              start: begin,
              old: source.slice(begin, end),
              new: change.newText,
              families: [entry.family],
            };
            const previous = edits.get(begin);
            if (previous && (previous.old !== edit.old || previous.new !== edit.new))
              throw new Error(`Conflicting semantic edits: ${entry.name}`);
            if (previous)
              edit.families = [...new Set([...previous.families, ...edit.families])].sort();
            edits.set(begin, edit);
          }
        }
      }
      const ordered = [...edits.values()].sort((a, b) => a.start - b.start);
      for (let index = 1; index < ordered.length; index++)
        if (ordered[index - 1].start + ordered[index - 1].old.length > ordered[index].start)
          throw new Error("Overlapping semantic edits");
      return ordered;
    },
  };
}

/** Collect compiler-bound identifier edits against one unchanged C++ source document. */
export async function semanticEdits(sourcePath, source, selection, flags) {
  const session = await semanticSession(sourcePath, source, flags);
  try {
    return await session.edits(selection);
  } finally {
    session.close();
  }
}
