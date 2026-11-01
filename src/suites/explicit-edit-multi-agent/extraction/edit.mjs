import { headerSpan } from "../cpp/cpp-tokens.mjs";

/** Select only this task's pieces inside its CURRENT guard envelope.
 * Repeated closing directives are selected at that envelope's end, never by a
 * global occurrence number or a stale preparation offset.
 */
export function extractCurrentHeader(before, task) {
  if (!/^[A-Za-z_][A-Za-z_0-9]*\.h$/.test(task.file) || before[task.file] !== undefined)
    throw Error("Invalid or existing extraction target");
  const source = before["main.cpp"];
  const span = headerSpan(source, task.guard);
  const body = source.slice(span.start, span.end);
  let cursor = 0;
  const edits = task.fragments.map(({ text }, index) => {
    let offset;
    if (index === 0) offset = 0;
    else if (index === task.fragments.length - 1) offset = body.length - text.length;
    else {
      offset = body.indexOf(text, cursor);
      if (offset >= 0 && body.indexOf(text, offset + 1) >= 0)
        throw Error("Ambiguous current extraction fragment");
    }
    if (offset < cursor || body.slice(offset, offset + text.length) !== text)
      throw Error("Owned current extraction fragment is missing");
    cursor = offset + text.length;
    return {
      start: span.start + offset,
      end: span.start + cursor,
      replacement: index === 0 ? task.replacement : "",
    };
  });
  let main = source;
  for (const edit of edits.reverse())
    main = main.slice(0, edit.start) + edit.replacement + main.slice(edit.end);
  return { ...before, "main.cpp": main, [task.file]: task.destination };
}
