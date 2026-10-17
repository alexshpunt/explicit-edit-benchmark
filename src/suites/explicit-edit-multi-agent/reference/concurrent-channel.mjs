import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

/** Current-task JSON transport into the explicit reference editing allowlist.
 * Closing targets the namespace init and awaits Bubblewrap's reaping, including
 * nested compiler sessions. No control socket or planner data enters candidate
 * source. The only optional RPC is a dispatched worker's current naming task.
 */
export function referenceChannel(workspace, tools, entry, { signal, naming } = {}) {
  signal?.throwIfAborted();
  const child = spawn(
    "/usr/bin/bwrap",
    [
      "--info-fd",
      "3",
      "--unshare-all",
      "--new-session",
      "--die-with-parent",
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/etc/ld.so.cache",
      "/etc/ld.so.cache",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      path.resolve(tools),
      "/executor",
      "--bind",
      path.resolve(workspace),
      "/workspace",
      "--chdir",
      "/workspace",
      "--ro-bind",
      process.execPath,
      "/renderer-node",
      "/renderer-node",
      `/executor/reference/${entry}`,
      "/workspace",
    ],
    { env: {}, stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  let pending,
    closing = false,
    namespace,
    information = "",
    stderr = "",
    failure;
  const terminate = () => {
    if (!namespace) return;
    try {
      process.kill(namespace, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") failure = error;
    }
  };
  const close = () => {
    closing = true;
    terminate();
    return closed;
  };
  const abort = () => {
    void close();
  };
  child.stdio[3].on("data", (bytes) => {
    information += bytes;
  });
  child.stdio[3].once("end", () => {
    if (!information.trim()) return;
    try {
      namespace = JSON.parse(information)["child-pid"];
      if (!Number.isSafeInteger(namespace) || namespace <= 0)
        throw Error("Missing reference namespace PID");
      if (closing) terminate();
    } catch (error) {
      failure = error;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-8192);
  });
  child.stdin.on("error", () => {});
  child.once("error", (error) => {
    failure = error;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (closing) return;
    let result;
    try {
      result = JSON.parse(line);
    } catch (error) {
      failure = error;
      void close();
      return;
    }
    if (result.type === "name-request") {
      if (
        !pending ||
        !naming ||
        pending.namingRequested ||
        JSON.stringify(result.task) !== pending.task
      ) {
        failure = Error("Unexpected reference naming request");
        void close();
        return;
      }
      pending.namingRequested = true;
      Promise.resolve()
        .then(() => naming(result.task))
        .then(
          (receipt) => {
            if (!closing)
              child.stdin.write(
                JSON.stringify({ type: "name-result", requestId: result.requestId, receipt }) +
                  "\n",
              );
          },
          (error) => {
            if (!closing)
              child.stdin.write(
                JSON.stringify({
                  type: "name-result",
                  requestId: result.requestId,
                  error: error.message,
                }) + "\n",
              );
          },
        );
      return;
    }
    const receipt = pending;
    pending = undefined;
    if (!receipt) {
      failure = Error("Unsolicited reference receipt");
      void close();
      return;
    }
    if (result.status !== "edited") receipt.reject(Error(result.error ?? "Isolated edit failed"));
    else receipt.resolve(result);
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      lines.close();
      closing = true;
      pending?.reject(
        signal?.aborted
          ? signal.reason
          : (failure ?? Error(stderr || `Isolated reference exited ${code}`)),
      );
      pending = undefined;
      resolve();
    }),
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    deliver(task) {
      if (closing || pending) throw Error("Reference channel closed or concurrent delivery");
      signal?.throwIfAborted();
      const serialized = JSON.stringify(task);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, task: serialized, namingRequested: false };
        child.stdin.write(serialized + "\n");
      });
    },
    close,
  };
}
