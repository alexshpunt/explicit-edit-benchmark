import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** Write the account files a participant sandbox shows as /etc/passwd and /etc/group.
 * Tools that look up the current user, such as Pi Agent IDE's shared language servers,
 * need an account entry; only the sandbox user's own entry is visible.
 */
export async function writeSandboxAccounts(state) {
  const accounts = path.join(state, "accounts");
  await mkdir(accounts);
  const [uid, gid] = [process.getuid(), process.getgid()];
  await writeFile(path.join(accounts, "passwd"), `agent:x:${uid}:${gid}::/state/home:/bin/bash\n`);
  await writeFile(path.join(accounts, "group"), `agent:x:${gid}:\n`);
  return accounts;
}

/** Bubblewrap arguments shared by every agent participant: a read-only system, the
 * runtime at /runtime, the participant's state at /state (plus `stateBinds` mounted
 * inside it), the workspace at /workspace, and an otherwise empty environment.
 * `environment` lists extra variables; with sharedSandbox the participant joins the
 * team's namespaces and /tmp instead of getting its own.
 */
export async function participantSandboxArgs({
  sharedSandbox,
  accounts,
  runtime,
  state,
  workspace,
  environment = {},
  stateBinds = [],
}) {
  const env = Object.entries({
    PATH: "/usr/bin:/bin",
    HOME: "/state/home",
    ...environment,
  }).flatMap(([key, value]) => ["--setenv", key, value]);
  return [
    // A shared sandbox supplies the user and PID namespaces when Bubblewrap joins it.
    ...(sharedSandbox ? [] : ["--unshare-user", "--unshare-pid"]),
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    ...env,
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--symlink",
    "usr/bin",
    "/bin",
    "--ro-bind",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    // Resolve standard /usr/bin alternative symlinks without binding all of /etc.
    "--ro-bind-try",
    "/etc/alternatives",
    "/etc/alternatives",
    "--ro-bind",
    await realpath("/etc/resolv.conf"),
    "/etc/resolv.conf",
    "--ro-bind",
    "/etc/ssl/certs",
    "/etc/ssl/certs",
    "--ro-bind",
    path.join(accounts, "passwd"),
    "/etc/passwd",
    "--ro-bind",
    path.join(accounts, "group"),
    "/etc/group",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...(sharedSandbox ? ["--bind", sharedSandbox.tmp, "/tmp"] : ["--tmpfs", "/tmp"]),
    "--ro-bind",
    runtime,
    "/runtime",
    "--bind",
    state,
    "/state",
    ...stateBinds,
    "--bind",
    path.resolve(workspace),
    "/workspace",
    "--chdir",
    "/workspace",
  ];
}
