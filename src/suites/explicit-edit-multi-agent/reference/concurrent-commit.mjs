import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Ordinary reads of the shared project, with no snapshot lock. A peer may
 * publish between these reads. Stable observation and semantic acceptance are
 * the controller's normal grading duties, not privileges of a reference editor.
 */
export async function readSharedSource(workspace) {
  const tree = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(workspace, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (!entry.isFile()) throw Error(`Nonregular candidate entry: ${name}`);
      else if (/\.(?:cpp|h)$/.test(name)) {
        const bytes = await readFile(path.join(workspace, name));
        const text = bytes.toString("utf8");
        if (!Buffer.from(text).equals(bytes)) throw Error(`Invalid source UTF-8: ${name}`);
        tree[name] = text;
      }
    }
  }
  await visit("");
  return tree;
}
