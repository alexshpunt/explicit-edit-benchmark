import { createInterface } from "node:readline/promises";

/** Wait for an operator to approve the exact candidate in a live run. */
export function createTerminalInspector({ input = process.stdin, output = process.stderr } = {}) {
  const terminal = createInterface({ input, output, terminal: false });
  const inspect = async (request) => {
    request.signal?.throwIfAborted();
    output.write(
      `Inspection ${request.sequence}, ${request.stage}, round ${request.round}\n` +
        `Assignments: ${request.ids.join(", ")}\n` +
        `Candidate: ${request.candidateIdentity}\nSnapshot: ${request.evidence}\nReport: ${request.report}\n`,
    );
    let onClose;
    const closed = new Promise((_resolve, reject) => {
      onClose = () => reject(new Error("Inspection input closed"));
      terminal.once("close", onClose);
    });
    try {
      const answer = await Promise.race([
        terminal.question("Approve with 'approve <inspection number> <candidate hash>': ", {
          signal: request.signal,
        }),
        closed,
      ]);
      if (answer !== `approve ${request.sequence} ${request.candidateIdentity}`)
        throw new Error("Inspection was not approved");
      return {
        runId: request.runId,
        sequence: request.sequence,
        candidateIdentity: request.candidateIdentity,
      };
    } finally {
      terminal.removeListener("close", onClose);
    }
  };
  inspect.close = () => terminal.close();
  return inspect;
}
