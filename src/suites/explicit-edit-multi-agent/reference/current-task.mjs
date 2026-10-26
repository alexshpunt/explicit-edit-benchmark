/** The editor receives current selectors and setup, not dependencies, future
 * assignments or the preparation engine's optional reference-order anchors.
 * Routing labels identify the mechanical operation described in the public goal.
 */
export function publicReferenceTask({ id, operations }) {
  return {
    id,
    operations: operations.map((operation) => {
      if (operation.action !== "implementation") return operation;
      return {
        ...operation,
        targets: operation.targets.map(({ before: _before, after: _after, ...target }) => target),
      };
    }),
  };
}
