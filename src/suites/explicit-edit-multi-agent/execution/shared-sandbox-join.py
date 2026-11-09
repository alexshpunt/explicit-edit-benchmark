"""Run Bubblewrap inside the user and PID namespaces of a running shared sandbox.

Usage: shared-sandbox-join.py SANDBOX_INIT_PID BWRAP_ARGUMENT...

Unprivileged Bubblewrap nests the sandbox user namespace inside the one that owns
the sandbox PID namespace. Joining that PID namespace needs the owning user
namespace first, so this helper opens both user namespaces and the PID namespace
and passes them to Bubblewrap, which drops back into the nested namespace after
setup. Every other descriptor the caller passed stays open.
"""

import fcntl
import os
import sys

NS_GET_USERNS = 0xB701

init = sys.argv[1]
assert init.isdecimal(), "The shared sandbox PID must be a number"
pid_namespace = os.open(f"/proc/{init}/ns/pid", os.O_RDONLY)
owner = fcntl.ioctl(pid_namespace, NS_GET_USERNS)
nested = os.open(f"/proc/{init}/ns/user", os.O_RDONLY)
for descriptor in (pid_namespace, owner, nested):
    os.set_inheritable(descriptor, True)
os.execvp(
    "bwrap",
    [
        "bwrap",
        "--userns",
        str(owner),
        "--userns2",
        str(nested),
        "--pidns",
        str(pid_namespace),
        *sys.argv[2:],
    ],
)
