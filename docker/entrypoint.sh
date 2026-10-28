#!/bin/sh
# Container entrypoint: run the server without root whenever that is safe.
#
# This script never chowns anything. People bind-mount their image library from
# disks they own (Unraid's nobody:users, a NAS share, an external drive), and
# recursively changing ownership there would rewrite someone's files. Instead it
# adopts the uid:gid that already owns the data directory:
#
#   fresh install      /app/data is owned by the image's "node" user, so the
#                      server runs as node.
#   bind-mounted data  the server runs as whoever owns that folder.
#   volume made by an  /app/data is owned by root, so the server keeps running
#   older (root) image as root, exactly as before, and logs how to switch.
#
# It also stays root if LIBRARY_DIR is not writable by the chosen user, so an
# upgrade never turns into "imports fail with permission denied".
set -eu

# Already unprivileged (compose `user:` or `docker run --user`): nothing to do.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

DATA="${DATA_DIR:-/app/data}"
LIB="${LIBRARY_DIR:-}"

if [ ! -d "$DATA" ]; then
  echo "[entrypoint] WARNING: $DATA does not exist; running as root." >&2
  exec "$@"
fi

uid="$(stat -c %u "$DATA")"
gid="$(stat -c %g "$DATA")"

if [ "$uid" = "0" ]; then
  echo "[entrypoint] NOTICE: $DATA is owned by root (created by an older image), so the server keeps running as root." >&2
  echo "[entrypoint] To run unprivileged: stop the container, chown -R 1000:1000 the data volume, start it again." >&2
  exec "$@"
fi

# Probe writability as the target user, not as root (root can write anywhere).
# Checks the folder itself and the two levels below it (object and session
# folders): a library first filled by an older root container has the right
# owner on the top folder but root-owned object folders, where imports and
# deletes would fail.
can_write() {
  setpriv --reuid="$uid" --regid="$gid" --clear-groups sh -c 'test -w "$1"' sh "$1" || return 1
  blocked="$(setpriv --reuid="$uid" --regid="$gid" --clear-groups \
    find "$1" -maxdepth 2 -type d ! -writable -print -quit 2>/dev/null)"
  [ -z "$blocked" ]
}

if [ -n "$LIB" ] && [ -d "$LIB" ] && ! can_write "$LIB"; then
  echo "[entrypoint] WARNING: $LIB is not writable by uid $uid, the owner of $DATA; the server will run as root so imports keep working." >&2
  echo "[entrypoint] To run unprivileged: make $LIB writable by uid $uid, or set the same owner on both folders." >&2
  exec "$@"
fi

# The unprivileged user may have no home directory; point HOME somewhere writable.
export HOME=/tmp
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@"
