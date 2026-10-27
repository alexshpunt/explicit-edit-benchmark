import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { indexBarrierSnapshot } from "../grading/barrier-symbol-map.mjs";
import { evaluateAtomicRoundCredit } from "../grading/atomic-round-credit.mjs";
import { measureCoherentCandidate } from "../grading/coherent-build.mjs";
import { compilerDiagnostics as locatedCompilerDiagnostics } from "../grading/repair-diagnostics.mjs";
import { decodeSourceBytes } from "../cpp/source-bytes.mjs";

const sourceEntry = (entry) =>
  /\.(?:cpp|h)$/.test(decodeSourceBytes(Buffer.from(entry.pathBytes, "base64")));
const relative = (file) =>
  typeof file === "string" &&
  file.length > 0 &&
  !path.posix.isAbsolute(file) &&
  !file.split("/").some((part) => part === ".." || part === ".");

// Physical entry presence is independent of whether its text can be lexed.
// A symlink or directory cannot satisfy a removed-file goal by disappearing
// from the regular-file lexical view. Ancestor links deny hidden-file absence.
function physicalInventory(credit, candidate, prepared) {
  const atoms = credit.atoms.map((atom) => ({ ...atom, failures: [...atom.failures] }));
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  const preservationFailures = [...credit.preservationFailures];
  const charge = (file, ids) => {
    const failure = { category: "source-entry", ...(file !== null ? { file } : {}) };
    if (!ids.size) preservationFailures.push(failure);
    for (const id of ids) byId.get(id).failures.push(failure);
  };
  const owners = (file) =>
    new Set([
      ...prepared.structural.fileGoals.filter((goal) => goal.file === file).map(({ id }) => id),
      ...prepared.frames
        .filter((frame) => frame.file === file)
        .flatMap((frame) => [...frame.ids, ...frame.requiredIds]),
    ]);
  for (const entry of candidate.manifest.entries) {
    if (sourceEntry(entry) && (entry.type !== "file" || entry.path === null))
      charge(entry.path, entry.path === null ? new Set() : owners(entry.path));
    if (!["symlink", "unsupported"].includes(entry.type) || entry.path === null) continue;
    const hidden = new Set(
      [...prepared.contract.files, ...prepared.structural.fileGoals.map(({ file }) => file)].filter(
        (file) => file.startsWith(`${entry.path}/`),
      ),
    );
    for (const file of hidden) charge(file, owners(file));
  }
  for (const atom of atoms) atom.passed = atom.failures.length === 0;
  return {
    ...credit,
    atoms,
    passed: atoms.filter(({ passed }) => passed).length,
    preservationFailures,
    integrityPassed: preservationFailures.length === 0,
  };
}

/** Measure original captured bytes. Lexical byte views never become compiler
 * input, and atom or integrity failures never suppress an independent build.
 */
export async function measureRestoringCandidate(
  candidate,
  prepared,
  { evidence, expectedPixels, signal } = {},
) {
  signal?.throwIfAborted();
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const entries = candidate.manifest.entries;
  // Special entries are retained as metadata rather than fabricated regular
  // files. Such a mirror cannot certify any original compiler context.
  const unmirrored = entries.some((entry) => entry.type === "unsupported");
  let symbols;
  if (unmirrored) {
    symbols = {
      version: "renderer-barrier-symbol-map-v1",
      compiler: null,
      status: "unavailable",
      reason: "unsupported-entry",
      symbols: [],
      bindings: [],
      diagnostics: [],
      credit: {
        version: "renderer-binding-anchors-v1",
        anchors: [],
        translationUnits: candidate.files
          .filter((file) => file.endsWith(".cpp"))
          .map((file) => ({ file, status: "fail", reason: "unsupported-entry", files: [file] })),
      },
    };
    await mkdir(path.join(evidence, "symbols"));
    await writeFile(path.join(evidence, "symbols/symbols.json"), JSON.stringify(symbols) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } else
    symbols = await indexBarrierSnapshot(candidate, {
      evidence: path.join(evidence, "symbols"),
      signal,
    });
  const tree = candidate.lexicalTree;
  const credit = physicalInventory(
    evaluateAtomicRoundCredit(tree, prepared, { candidateSymbols: symbols }),
    candidate,
    prepared,
  );
  const unrepresentable = entries.some((entry) => sourceEntry(entry) && entry.path === null);
  const build =
    unmirrored || unrepresentable
      ? {
          buildPassed: false,
          resultMatched: false,
          failure: { category: "build", reason: "unsupported-source-input" },
        }
      : await measureCoherentCandidate(
          candidate.source,
          path.join(evidence, "build-output"),
          Object.fromEntries(candidate.files.map((file) => [file, ""])),
          { expectedPixels, signal },
        );
  const diagnostics = [
    ...credit.atoms.flatMap(({ failures }) => failures),
    ...credit.preservationFailures,
  ].map((failure) => ({
    category: "structure",
    status: "fail",
    kind: failure.category,
    ...(relative(failure.file) ? { file: failure.file } : {}),
  }));
  const compilerDiagnostics = locatedCompilerDiagnostics(
    [...symbols.diagnostics, build.failure?.cause?.stderr ?? ""].join("\n"),
    tree,
  );
  const successful = new Set(
    symbols.credit.translationUnits
      .filter(({ status }) => status === "pass")
      .map(({ file }) => file),
  );
  const measured = {
    passedAtoms: credit.passed,
    totalAtoms: credit.total,
    buildPassed: build.buildPassed,
    resultMatched: build.resultMatched,
    integrityPassed: credit.integrityPassed,
    category:
      credit.passed !== credit.total || !credit.integrityPassed
        ? "structure"
        : !build.buildPassed
          ? "build"
          : "behavior",
    diagnostics: [...new Map(diagnostics.map((item) => [JSON.stringify(item), item])).values()],
    compilerDiagnostics,
    bindings: symbols.bindings.filter(
      (binding) => !binding.recovered && successful.has(binding.translationUnit),
    ),
    credit,
  };
  await writeFile(
    path.join(evidence, "measurement.json"),
    JSON.stringify({
      ...measured,
      bindings: undefined,
      credit: undefined,
      compilerStatus: symbols.status,
      build: {
        ...build,
        failure: build.failure
          ? {
              category: build.failure.category,
              reason: build.failure.reason,
              message: build.failure.message,
            }
          : undefined,
      },
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return measured;
}
