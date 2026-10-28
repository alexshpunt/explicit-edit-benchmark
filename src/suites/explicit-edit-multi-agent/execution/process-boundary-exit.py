"""Wait on kernel pidfds for the last members of an owned, pinned PID namespace."""

import errno
import os
import select
import sys

namespace = sys.argv[1]
fds = []
try:
    for name in os.listdir("/proc"):
        if not name.isdecimal():
            continue
        fd = None
        try:
            link = f"/proc/{name}/ns/pid"
            if os.readlink(link) != namespace:
                continue
            fd = os.pidfd_open(int(name))
            if os.readlink(link) != namespace:
                os.close(fd)
                continue
            fds.append(fd)
        except OSError as error:
            if fd is not None:
                os.close(fd)
            if error.errno not in (errno.ENOENT, errno.ESRCH, errno.EACCES, errno.EPERM):
                raise
    for fd in fds:
        select.select([fd], [], [])
finally:
    for fd in fds:
        os.close(fd)
