#!/usr/bin/env bash
# Machine-wide queue for heavy runs (verify, release builds, e2e). Parallel agents in
# different worktrees share one lock so they do not starve each other of CPU/RAM.
set -euo pipefail
LOCK="${ZOOD_QUEUE_LOCK:-/tmp/zood-pdf-heavy.lock}"
exec 9>"$LOCK"
echo "[queue] waiting for $LOCK ($*)" >&2
flock 9
echo "[queue] running: $*" >&2
"$@"
