import { scopedNamingSession, applyScopedNamePlan } from "../cpp/scoped-names.mjs";

// One current-task compiler lifetime. Exiting releases AST memory before the
// persistent reference agent accepts another task. No saved answers are read.
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const { before, task } = JSON.parse(input);

async function plans(file, allowAbsentOwners = false) {
  const session = await scopedNamingSession(before, "/tmp/current-analysis", {
    file,
    allowAbsentOwners,
  });
  try {
    const result = [];
    for (const op of task.operations) result.push(await session.plan(op));
    return result;
  } finally {
    session.close();
  }
}
let selected;
try {
  selected = await plans(
    task.operations[0].category === "helpers" ? task.operations[0].file : undefined,
  );
} catch (error) {
  // A combined analysis view is only a fast path. Valid separate C++ units can
  // have equal internal-linkage names after independent helper restorations.
  // Compile each actual unit and merge physical edits instead of rejecting that
  // valid project or adding false dependencies to the benchmark task graph.
  if (!error.message.startsWith("Compiler AST failed:")) throw error;
  const merged = task.operations.map(() => new Map());
  for (const file of Object.keys(before)
    .filter((name) => name.endsWith(".cpp"))
    .sort()) {
    const current = await plans(file, true);
    for (const [index, plan] of current.entries()) {
      for (const edit of plan.edits) {
        const key = JSON.stringify([edit.file, edit.start]);
        const previous = merged[index].get(key);
        if (previous && (previous.old !== edit.old || previous.new !== edit.new))
          throw Error("Conflicting translation-unit binding edit", { cause: error });
        merged[index].set(key, edit);
      }
    }
  }
  selected = task.operations.map((op, index) => {
    const edits = [...merged[index].values()];
    for (const mapping of op.mapping)
      if (!edits.some((edit) => edit.old === mapping.from && edit.new === mapping.to))
        throw Error(`Missing current owner/signature binding: ${mapping.from}`, { cause: error });
    return { id: op.id ?? op.target, edits };
  });
}
let after = before;
const applied = [];
for (const plan of selected) {
  after = applyScopedNamePlan(after, plan, applied);
  applied.push(plan);
}
process.stdout.write(JSON.stringify(after) + "\n");
