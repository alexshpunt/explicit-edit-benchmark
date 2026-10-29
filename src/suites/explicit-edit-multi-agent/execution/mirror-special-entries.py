"""Reproduce captured inert special-entry types in a private candidate mirror."""

import base64
import json
import os
import socket
import stat
import sys


def open_parent(root, parts):
    parent = os.dup(root)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent
    except BaseException:
        os.close(parent)
        raise


def mirror(root_path, plan_path):
    with open(plan_path, "rb") as source:
        entries = json.load(source)
    if not isinstance(entries, list):
        raise ValueError("Invalid special-entry plan")
    root = os.open(os.fsencode(root_path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"pathBytes", "kind", "mode"}:
                raise ValueError("Invalid special-entry record")
            relative = base64.b64decode(entry["pathBytes"], validate=True)
            parts = relative.split(b"/")
            if any(part in (b"", b".", b"..") or b"\0" in part for part in parts):
                raise ValueError("Invalid special-entry path")
            kind = entry["kind"]
            mode = int(entry["mode"])
            expected_type = stat.S_IFIFO if kind == "fifo" else stat.S_IFSOCK if kind == "socket" else None
            if expected_type is None or stat.S_IFMT(mode) != expected_type:
                raise ValueError("Unsupported special-entry type")
            parent = open_parent(root, parts)
            try:
                # Binding relative to the verified parent avoids the Unix socket
                # address-length limit imposed by the private mirror prefix.
                os.fchdir(parent)
                if kind == "fifo":
                    os.mkfifo(parts[-1], mode & 0o777)
                else:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as endpoint:
                        endpoint.bind(parts[-1])
                # The basename was created exclusively in this verified private
                # parent. No candidate process can mutate this mirror.
                os.chmod(parts[-1], mode & 0o777, dir_fd=parent)
                if stat.S_IFMT(os.stat(parts[-1], follow_symlinks=False).st_mode) != expected_type:
                    raise ValueError("Mirrored special-entry type differs")
            finally:
                os.close(parent)
    finally:
        os.close(root)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise ValueError("Expected mirror root and private plan")
    mirror(sys.argv[1], sys.argv[2])
