import { render } from "preact";
import type { PackedTrace } from "../../trace/types.ts";
import { App } from "./app.tsx";
import { required } from "../../../required.ts";

/** The built page carries the trace as gzipped JSON in base64 inside
 * <script id="agent-replay-trace" type="application/gzip+base64">. The dev server serves it at /__trace. */
async function loadTrace(): Promise<PackedTrace> {
  const embedded = document.getElementById("agent-replay-trace");
  const packed = embedded?.textContent.trim();
  if (packed) {
    const binary = atob(packed);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text()) as PackedTrace;
  }
  const response = await fetch("./__trace");
  if (!response.ok) throw new Error(`No trace: ${response.status}`);
  return (await response.json()) as PackedTrace;
}

const root = required(document.getElementById("app"));
loadTrace().then(
  (trace) => render(<App trace={trace} />, root),
  (error: Error) => {
    root.innerHTML = `<div class="load-error">Could not load the trace: ${error.message}</div>`;
  },
);
