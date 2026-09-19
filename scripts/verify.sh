#!/bin/zsh
# Everything CI runs, locally, with a one-line verdict per step:
#   ./scripts/verify.sh            # the whole suite
#   ./scripts/verify.sh --no-e2e   # all but the browser tests
# Works from any checkout or worktree of the repository. Logs go to
# $WARRAQ_LOGS (default: a temporary directory), one file per step.
repo=${0:A:h:h}
cd "$repo" || exit 1
# The machine's toolchain helpers are git-ignored; a worktree borrows the main checkout's.
for env in "$repo/.tools/env.sh" "$HOME/Developer/warraq/.tools/env.sh"; do
  [ -f "$env" ] && { source "$env"; break; }
done
logs=${WARRAQ_LOGS:-$(mktemp -d)}
fail=0
run() { local name=$1; shift; local out; out=$("$@" 2>&1); local code=$?; if [ $code -eq 0 ]; then echo "PASS $name"; else echo "FAIL $name (exit $code)"; echo "$out" | tail -25; fail=1; fi; echo "$out" > "$logs/verify-$name.log"; }
run lint pnpm -r lint
run unit pnpm -r test
run typecheck pnpm -r --filter './packages/**' build
run webbuild pnpm --filter @warraq/web build
run extbuild pnpm --filter @warraq/extension build
run extcheck pnpm --filter @warraq/extension check
run corefmt cargo fmt --all --check --manifest-path packages/core/Cargo.toml
run coreclippy cargo clippy --all-targets --manifest-path packages/core/Cargo.toml -- -D warnings
run coretest cargo test --manifest-path packages/core/Cargo.toml
# CI's Arabic extraction gate; the results file carries timings, so it is put back.
acid() { cp tests/acid/results-warraq.json "$logs/acid-keep.json"; cargo run --release --manifest-path packages/core/Cargo.toml -p warraq-core --example acid -- . >/dev/null && python3 tests/acid/gate_warraq.py .; local s=$?; cp "$logs/acid-keep.json" tests/acid/results-warraq.json; return $s; }
run acid acid
# The desktop app is a cargo workspace of its own. In a target directory
# shared with the core workspace (CARGO_TARGET_DIR), both write the same
# unhashed deps/libwarraq_core.rlib — warraq-core is a cdylib too — and the
# desktop then links the core workspace's copy and fails with "multiple
# different versions of crate". A subdirectory of its own keeps them apart.
desk() { if [ -n "$CARGO_TARGET_DIR" ]; then CARGO_TARGET_DIR="$CARGO_TARGET_DIR/desktop" "$@"; else "$@"; fi; }
run deskfmt desk cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
run deskclippy desk cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
run desktest desk cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
[ "$1" = "--no-e2e" ] || run e2e pnpm --filter @warraq/web e2e
grep -hE "Tests +[0-9]+" "$logs/verify-unit.log"
grep -hE "^test result" "$logs/verify-coretest.log" | awk '{p+=$4; f+=$6} END {print "core tests passed:", p, "failed:", f}'
grep -hE "^test result" "$logs/verify-desktest.log" | awk '{p+=$4; f+=$6} END {print "desktop tests passed:", p, "failed:", f}'
[ -f "$logs/verify-e2e.log" ] && grep -hE "passed|failed" "$logs/verify-e2e.log" | tail -2
grep -hE "^checked" "$logs/verify-acid.log"
echo "logs in $logs"
echo "VERDICT $([ $fail -eq 0 ] && echo GREEN || echo RED)"
