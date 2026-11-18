import { StringDecoder } from "node:string_decoder";
import { ExecutionFailure } from "./request-chain.mjs";

export const RPC_RECORD_LIMIT = 32 * 1024 * 1024;
const PREVIEW_BYTES = 4096;

export class OversizedRpcRecord extends ExecutionFailure {
  constructor(stream, bytes) {
    super(
      "driver_exit",
      `Pi ${stream} record exceeds the ${RPC_RECORD_LIMIT}-byte limit (${bytes} bytes received)`,
    );
    this.code = "RPC_RECORD_OVERSIZED";
    this.stream = stream;
    this.bytes = bytes;
  }
}

/** Recover only complete top-level envelope fields visible in the bounded prefix. */
function envelope(head) {
  const fields = { type: null, toolName: null, toolCallId: null, id: null };
  // A token beginning with a quote must end with an unescaped quote inside the prefix.
  const tokens = /\s*("(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s"{}[\]:,]+)/gy;
  let depth = 0;
  let key = null;
  let token;
  while ((token = tokens.exec(head))) {
    const value = token[1];
    if (depth === 1 && key !== null && value !== ":") {
      if (Object.hasOwn(fields, key) && value.startsWith('"')) {
        fields[key] = JSON.parse(value);
      }
      key = null;
    }
    if (value === "{" || value === "[") depth++;
    if (value === "}" || value === "]") depth--;
    if (depth === 1 && value.startsWith('"') && /^\s*:/.test(head.slice(tokens.lastIndex))) {
      key = JSON.parse(value);
    }
  }
  return {
    recordType: fields.type,
    toolName: fields.toolName,
    toolCallId: fields.toolCallId,
    id: fields.id,
  };
}

function previewText(bytes, fromEnd = false) {
  let start = 0;
  // A tail slice can start inside a code point. A head slice can end inside one.
  if (fromEnd) while ((bytes[start] & 0xc0) === 0x80) start++;
  const text = new StringDecoder("utf8").write(bytes.subarray(start));
  if (Buffer.byteLength(text) <= bytes.length) return text;
  // Invalid UTF-8 can expand when replaced with U+FFFD. Keep the text bounded too.
  const encoded = Buffer.from(text);
  if (!fromEnd) return new StringDecoder("utf8").write(encoded.subarray(0, bytes.length));
  start = encoded.length - bytes.length;
  while ((encoded[start] & 0xc0) === 0x80) start++;
  return encoded.toString("utf8", start);
}

/** Count bytes per LF-delimited record, including an unterminated final line.
 * Keep the full line only while it fits; drain an oversized line with two previews.
 */
export function readPiRpcLines(stream, consume, oversized, { limit = RPC_RECORD_LIMIT } = {}) {
  let bytes = 0;
  /** @type {Buffer[]} */
  let chunks = [];
  let head = null;
  let tail = Buffer.alloc(0);
  const previewBytes = Math.min(limit, PREVIEW_BYTES);

  function retainTail(part) {
    if (part.length >= previewBytes) tail = Buffer.from(part.subarray(-previewBytes));
    else
      tail = Buffer.concat([
        tail.subarray(Math.max(0, tail.length + part.length - previewBytes)),
        part,
      ]);
  }

  function add(part) {
    bytes += part.length;
    if (bytes <= limit) {
      if (part.length) chunks.push(part);
      return;
    }
    if (!head) {
      chunks.push(part);
      head = preview(chunks, false);
      tail = preview(chunks, true);
      chunks = [];
    } else if (part.length) retainTail(part);
  }

  function preview(parts, fromEnd) {
    const slices = [];
    let remaining = previewBytes;
    for (let i = 0; remaining > 0; i++) {
      const part = parts[fromEnd ? parts.length - 1 - i : i];
      const size = Math.min(remaining, part.length);
      slices.push(fromEnd ? part.subarray(-size) : part.subarray(0, size));
      remaining -= size;
    }
    return Buffer.concat(fromEnd ? slices.reverse() : slices, previewBytes);
  }

  function finish() {
    if (!bytes) return;
    const size = bytes;
    const first = head;
    const last = tail;
    const parts = chunks;
    bytes = 0;
    head = null;
    tail = Buffer.alloc(0);
    chunks = [];
    if (!first) {
      consume(Buffer.concat(parts, size).toString("utf8"));
      return;
    }
    const prefix = previewText(first);
    let fields;
    try {
      fields = envelope(prefix.replace(/^RENDERER_BASELINE /, ""));
    } catch {
      fields = { recordType: null, toolName: null, toolCallId: null, id: null };
    }
    oversized({ bytes: size, ...fields, head: prefix, tail: previewText(last, true) });
  }

  stream.on("data", (chunk) => {
    let start = 0;
    let end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      add(chunk.subarray(start, end));
      finish();
      start = end + 1;
    }
    if (start < chunk.length) add(chunk.subarray(start));
  });
  stream.on("end", finish);
}
