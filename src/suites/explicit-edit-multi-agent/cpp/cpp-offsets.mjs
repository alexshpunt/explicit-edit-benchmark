/** Convert compiler UTF-8 byte positions to JS string positions without rescanning prefixes.
 * Reject a position inside a multibyte code point instead of cutting a physical token.
 */
export function byteToCharacter(source) {
  const size = Buffer.byteLength(source);
  if (size === source.length)
    return (offset) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size)
        throw new Error("Invalid compiler byte offset");
      return offset;
    };
  const positions = new Int32Array(size + 1).fill(-1);
  let byte = 0,
    character = 0;
  for (const point of source) {
    positions[byte] = character;
    byte += Buffer.byteLength(point);
    character += point.length;
  }
  positions[byte] = character;
  return (offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || positions[offset] < 0)
      throw new Error("Invalid compiler byte boundary");
    return positions[offset];
  };
}
