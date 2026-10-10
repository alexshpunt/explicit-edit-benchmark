import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cppTokens } from "../generation/generator.mjs";

const execFile = promisify(execFileCallback);
const standard = new Set(
  `algorithm any array atomic bitset cassert cctype cerrno cfloat chrono climits cmath complex
condition_variable cstddef cstdint cstdio cstdlib cstring ctime deque exception execution
fstream functional future initializer_list iomanip ios iosfwd iostream istream iterator limits
list map memory mutex new numeric optional ostream queue random ratio regex scoped_allocator
set shared_mutex sstream stack stdexcept streambuf string string_view system_error thread tuple
type_traits typeindex typeinfo unordered_map unordered_set utility valarray variant vector`.split(
    /\s+/,
  ),
);

/** Prove repeated standard includes and inactive include-only blocks in the pinned preprocessor state. */
export async function includeBoundaries(sourcePath, flags) {
  const source = await readFile(sourcePath, "utf8");
  const starts = [];
  let offset = 0;
  for (const line of source.split("\n")) {
    starts.push(offset);
    offset += Buffer.byteLength(line) + 1;
  }
  const { stdout } = await execFile("clang++", [...flags, "-E", "-dI", sourcePath], {
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  const seen = new Set();
  const repeated = new Set();
  const activeIncludes = new Set();
  let file = "";
  let sourceLine = 0;
  for (const line of stdout.split("\n")) {
    const marker = /^# (\d+) ("(?:[^"\\]|\\.)*")/.exec(line);
    if (marker) {
      sourceLine = Number(marker[1]);
      file = JSON.parse(marker[2]);
      continue;
    }
    const include = /^#include\s+([<"].*[>"])/.exec(line);
    if (path.resolve(file || ".") === sourcePath && include)
      activeIncludes.add(starts[sourceLine - 1]);
    const header = /^<([a-z_]+)>/.exec(include?.[1] ?? "");
    if (path.resolve(file || ".") === sourcePath && header && standard.has(header[1])) {
      if (seen.has(header[1])) repeated.add(starts[sourceLine - 1]);
      seen.add(header[1]);
    }
    sourceLine++;
  }
  const inactive = new Set();
  const protectedTokens = cppTokens(source).filter(
    (token) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(token.text),
  );
  // No else, nesting, definitions or statements: only optional includes and blank lines.
  const leaf =
    /^[ \t]*#[ \t]*(?:if|ifdef|ifndef)\b[^\n]*\n(?:[ \t]*(?:#[ \t]*include\b[^\n]*)?\n)+[ \t]*#[ \t]*endif\b[^\n]*/gm;
  for (const match of source.matchAll(leaf)) {
    if (protectedTokens.some((token) => token.start <= match.index && token.end > match.index))
      continue;
    const start = Buffer.byteLength(source.slice(0, match.index));
    const end = start + Buffer.byteLength(match[0]);
    if ([...activeIncludes].some((offset) => offset >= start && offset < end)) continue;
    for (const directive of match[0].matchAll(/^[ \t]*#.*$/gm))
      inactive.add(start + Buffer.byteLength(match[0].slice(0, directive.index)));
  }
  return { repeated, inactive };
}
