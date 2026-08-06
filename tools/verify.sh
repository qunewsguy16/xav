#!/usr/bin/env bash
#
# Build-matrix gate for the Windows port.
#
# Run after every change, and especially after every upstream sync. Upstream is
# active and does not take outside PRs, so this fork carries a permanent delta;
# without a matrix check a rebase can silently break a configuration that is
# never exercised on the machine doing the rebase.
#
# Linux is the hard gate: it is what upstream tests, and the deny-all lint
# config means one careless #[cfg] breaks it.
#
#   ./tools/verify.sh
#   CLIPPY_BASELINE=44 ./tools/verify.sh     # also gate clippy drift
#
# Requires: rust nightly, the two windows targets, nasm, clang.
#   rustup toolchain install nightly
#   rustup target add x86_64-pc-windows-gnu x86_64-pc-windows-msvc --toolchain nightly

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0

run() {
    local name="$1"
    shift
    local out
    if out=$("$@" 2>&1); then
        printf '  PASS  %s\n' "$name"
        pass=$((pass + 1))
    else
        printf '  FAIL  %s\n' "$name"
        printf '%s\n' "$out" | grep -E '^(error|warning)' | head -25 | sed 's/^/        /'
        fail=$((fail + 1))
    fi
}

# Linux uses the project's own .cargo/config.toml -- do NOT override RUSTFLAGS
# here. The no_std path needs the panic=abort the config supplies, and
# target-cpu=native to get above the AVX2 floor that build.rs assembles for.
echo "== Linux (project .cargo/config.toml) =="
for feat in "" "--features vship"; do
    # shellcheck disable=SC2086
    run "check  ${feat:-no-tq}" env -u RUSTFLAGS cargo +nightly check --no-default-features $feat
    # shellcheck disable=SC2086
    run "clippy ${feat:-no-tq}" env -u RUSTFLAGS cargo +nightly clippy --no-default-features $feat
done

# Windows takes the std path. Two CPU models: an AVX-512 box, and a realistic
# AVX2-only box -- plain x86-64-v3 omits PCLMULQDQ, which no real CPU since
# Westmere lacks, so it is added back explicitly. Without it the crc32 kernels
# report a failure no actual machine would ever hit.
echo "== Windows cross-check =="
for cpu in "-C target-cpu=x86-64-v4" "-C target-cpu=x86-64-v3 -C target-feature=+pclmulqdq"; do
    for tgt in x86_64-pc-windows-gnu x86_64-pc-windows-msvc; do
        for feat in "" "--features vship"; do
            # shellcheck disable=SC2086
            run "$tgt [${cpu##*=}] ${feat:-no-tq}" \
                env RUSTFLAGS="$cpu" cargo +nightly check --target "$tgt" --no-default-features $feat
        done
    done
done

# Clippy on a Windows target lints plat.rs and platform/windows.rs, which it has
# never seen upstream (they are cfg'd out on Linux). Those findings are
# pre-existing and cargo build does not run clippy, so they do not block --
# but the count must not grow. Driving it to zero would mean a large diff in
# upstream-owned files for no functional gain.
echo "== Windows clippy (drift gate) =="
found=$(env RUSTFLAGS="-C target-cpu=x86-64-v4" \
    cargo +nightly clippy --target x86_64-pc-windows-gnu \
    --no-default-features --features vship 2>&1 | grep -cE '^error')
printf '  findings: %s (baseline: %s)\n' "$found" "${CLIPPY_BASELINE:-unset}"
if [ -n "${CLIPPY_BASELINE:-}" ] && [ "$found" -gt "$CLIPPY_BASELINE" ]; then
    printf '  FAIL  clippy findings grew (%s -> %s)\n' "$CLIPPY_BASELINE" "$found"
    fail=$((fail + 1))
fi

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
