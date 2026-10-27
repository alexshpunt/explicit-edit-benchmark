import { isUtf8 } from "node:buffer";

const escapedByte = (point) => point >= 0xdc80 && point <= 0xdcff;
const unpaired = (point) => point >= 0xd800 && point <= 0xdfff;

/** Lossless lexical view of original bytes. Invalid UTF-8 bytes occupy otherwise
 * unrepresentable low-surrogate code units, distinct from a genuine U+FFFD.
 * Compiler input always remains the original captured file, never a re-encoding
 * of a repaired or partially decoded candidate.
 */
export function decodeSourceBytes(bytes) {
  if (isUtf8(bytes)) return bytes.toString("utf8");
  const chunks = [];
  let start = 0;
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index];
    if (byte < 0x80) {
      index++;
      continue;
    }
    const width =
      byte >= 0xc2 && byte <= 0xdf
        ? 2
        : byte >= 0xe0 && byte <= 0xef
          ? 3
          : byte >= 0xf0 && byte <= 0xf4
            ? 4
            : 1;
    if (width > 1 && isUtf8(bytes.subarray(index, index + width))) {
      index += width;
      continue;
    }
    chunks.push(bytes.subarray(start, index).toString("utf8"), String.fromCharCode(0xdc00 + byte));
    start = ++index;
  }
  chunks.push(bytes.subarray(start).toString("utf8"));
  return chunks.join("");
}

/** Reverse only the byte-preserving lexical representation. These bytes are
 * useful for lexical span calculations; they never substitute a compiler run.
 */
export function encodeSourceBytes(source) {
  if (source.isWellFormed()) return Buffer.from(source);
  const chunks = [];
  let start = 0;
  for (let index = 0; index < source.length;) {
    const point = source.codePointAt(index);
    if (escapedByte(point)) {
      chunks.push(Buffer.from(source.slice(start, index)), Buffer.from([point - 0xdc00]));
      start = ++index;
    } else {
      if (unpaired(point)) throw new TypeError("Source contains an unpaired non-byte surrogate");
      index += point > 0xffff ? 2 : 1;
    }
  }
  chunks.push(Buffer.from(source.slice(start)));
  return Buffer.concat(chunks);
}

/** UTF-16 lexical positions to original byte positions, including malformed
 * source bytes and non-BMP Unicode. The interior of a pair maps to its start.
 */
export function sourceByteOffsets(source) {
  const offsets = new Uint32Array(source.length + 1);
  let byte = 0;
  for (let index = 0; index < source.length;) {
    const point = source.codePointAt(index),
      width = point > 0xffff ? 2 : 1;
    offsets[index] = byte;
    if (width === 2) offsets[index + 1] = byte;
    if (escapedByte(point)) byte++;
    else {
      if (unpaired(point)) throw new TypeError("Source contains an unpaired non-byte surrogate");
      byte += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    index += width;
    offsets[index] = byte;
  }
  return offsets;
}
