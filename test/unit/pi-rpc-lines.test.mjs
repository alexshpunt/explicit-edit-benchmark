import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readPiRpcLines } from "../../src/suites/explicit-edit-multi-agent/execution/pi-rpc-lines.mjs";

async function read(chunks, limit) {
  const stream = new PassThrough();
  const records = [];
  readPiRpcLines(
    stream,
    (line) => records.push(line),
    (diagnostic) => records.push(diagnostic),
    { limit },
  );
  const ended = once(stream, "end");
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await ended;
  return records;
}

test("the RPC limit is per line and counts UTF-8 bytes instead of UTF-16 units", async () => {
  const atLimit = Buffer.from('"ééé"');
  const overLimit = '"éééa"';
  const [first, second, diagnostic, final] = await read(
    [
      atLimit.subarray(0, 2),
      Buffer.concat([atLimit.subarray(2), Buffer.from(`\n${atLimit}\n${overLimit}\nfalse`)]),
    ],
    atLimit.length,
  );
  assert.deepEqual([first, second, final], [atLimit.toString(), atLimit.toString(), "false"]);
  assert.equal(diagnostic.bytes, Buffer.byteLength(overLimit));
});

test("a large tool event keeps bounded previews and only its own envelope fields", async () => {
  const prefix =
    '{"type":"tool_execution_end","toolName":"replace","toolCallId":"call-42","result":{"toolName":"nested","text":"';
  const suffix = 'last bytes"}}';
  const middle = "x".repeat(6000);
  const line = prefix + middle.repeat(4) + suffix;
  const [diagnostic] = await read([prefix, middle, middle, middle, middle, suffix], 8192);
  assert.deepEqual(diagnostic, {
    recordType: "tool_execution_end",
    toolName: "replace",
    toolCallId: "call-42",
    id: null,
    bytes: Buffer.byteLength(line),
    head: line.slice(0, 4096),
    tail: line.slice(-4096),
  });
});

test("previews do not split UTF-8 characters or exceed their byte budget", async () => {
  const [diagnostic] = await read(['"' + "🌍".repeat(4000) + '"\n'], 8192);
  assert.equal(diagnostic.bytes, 16002);
  assert.equal(diagnostic.head, '"' + "🌍".repeat(1023));
  assert.equal(diagnostic.tail, "🌍".repeat(1023) + '"');
});
