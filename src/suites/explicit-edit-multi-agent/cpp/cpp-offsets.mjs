import { sourceByteOffsets } from "./source-bytes.mjs";

/** Convert compiler byte positions to JS lexical positions without rescanning
 * prefixes. Invalid source bytes keep their one-byte lexical representation.
 * Reject positions inside a multibyte point instead of cutting a physical token.
 */
export function byteToCharacter(source) {
  const directSize = Buffer.byteLength(source);
  if (directSize === source.length)
    return (offset) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > directSize)
        throw new Error("Invalid compiler byte offset");
      return offset;
    };
  const bytes = sourceByteOffsets(source),
    size = bytes.at(-1);
  const positions = new Int32Array(size + 1).fill(-1);
  for (let index = 0; index < source.length; index += source.codePointAt(index) > 0xffff ? 2 : 1)
    positions[bytes[index]] = index;
  positions[size] = source.length;
  return (offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || positions[offset] < 0)
      throw new Error("Invalid compiler byte boundary");
    return positions[offset];
  };
}
