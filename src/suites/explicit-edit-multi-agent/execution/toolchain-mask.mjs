import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Compilers, language servers and their libraries an agent could use to resolve
 * C++ semantics. The dynamic loader, the assembler and the linker stay available.
 */
const BINARY = /^(clang|clangd|clang-.*|clang\+\+.*|g\+\+.*|gcc.*|c\+\+|cc|cpp(-.*)?|x86_64-linux-gnu-(g\+\+|gcc|cpp|c\+\+).*|llvm-.*|asan_symbolize.*|cmake|pip3?)$/;
const LIBRARY = /^(libclang.*\.so.*|libLLVM.*\.so.*)$/;
const DIRECTORIES = [
  "/usr/lib/gcc",
  "/usr/libexec/gcc",
  "/usr/lib/python3/dist-packages/clang",
  "/usr/lib/python3/dist-packages/pip",
];

/** Whether a /usr/bin entry belongs to the hidden toolchain. */
export const isToolchainBinary = (name) => BINARY.test(name);

/** Bubblewrap arguments that hide the toolchain inside the read-only /usr bind:
 * binaries and libraries become /dev/null, toolchain directories empty tmpfs.
 */
export async function hiddenToolchainArgs() {
  const files = new Set();
  const directories = new Set();
  const add = async (target, into) => {
    try {
      const real = await realpath(target);
      if (real.startsWith("/usr/")) into.add(real);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  for (const name of await readdir("/usr/bin"))
    if (isToolchainBinary(name)) await add(path.join("/usr/bin", name), files);
  for (const name of await readdir("/usr/lib/x86_64-linux-gnu").catch(() => []))
    if (LIBRARY.test(name)) await add(path.join("/usr/lib/x86_64-linux-gnu", name), files);
  for (const name of await readdir("/usr/lib"))
    if (/^llvm-\d+$/.test(name)) await add(path.join("/usr/lib", name), directories);
  for (const directory of DIRECTORIES) await add(directory, directories);
  const args = [];
  for (const directory of [...directories].sort()) args.push("--tmpfs", directory);
  for (const file of [...files].sort()) {
    // Files inside a hidden directory are already gone.
    if ([...directories].some((directory) => file.startsWith(directory + "/"))) continue;
    if ((await stat(file)).isFile()) args.push("--ro-bind", "/dev/null", file);
  }
  return args;
}
