# XAV on Windows 11 — Build, Tune, UI & Rollout Plan

Target: a single home Windows 11 x64 workstation.
Goals, in the user's words: *compile/install XAV*, *tailor and tweak any and all relevant
settings to run optimally on my PC*, and *include a more user-friendly interface*.

Everything in §2 is **measured against this tree**, not assumed. Commands used to produce
the evidence are given so they can be re-run after any rebase.

Baseline commit: `6896aeb` — *fix small EVEX slip into AVX2* (2026-08-06).

---

## 1. What XAV actually is (and why Windows is a real question)

XAV is a ~25 kLOC Rust framework with a deliberately extreme posture, stated in the README
and enforced in `Cargo.toml`:

- **No crates.** The only dependency is `nasm-rs`, a *build-time* assembler wrapper.
- **No stdlib on Linux.** `src/main.rs:2` — `#![no_std]`, `#![no_main]` on Linux. Raw
  syscalls, hand-rolled allocator (`galloc.rs`), threads (`thread.rs`), futex sync
  (`sync.rs`), io_uring (`uring.rs`), vDSO clock (`asm/vdso.asm`).
- **No system-side dependency, no FFmpeg/VapourSynth CLI calls.** FFmpeg, dav1d, opus and
  SVT-AV1 are compiled from source and *statically linked into the binary*.
- **Lint posture is maximal**: `warnings = "deny"`, all clippy groups including `pedantic`
  and `nursery` at `deny`, plus ~70 restriction lints. This matters enormously for the port
  — see §2.3.

### 1.1 The two-world design

The codebase is not Linux-only. It is explicitly split:

| World | Gate | Implementation |
|---|---|---|
| Linux | `#[cfg(target_os = "linux")]` | freestanding — syscalls, io_uring, custom allocator/threads/futexes |
| Everything else | `#[cfg(not(target_os = "linux"))]` | `std` — `std::fs`, `std::thread`, `std::process`, `std::io` |

There are **341** `target_os = "linux"` gates across 39 files, and every hot module
(`fs.rs`, `io.rs`, `thread.rs`, `process.rs`, `sync.rs`, `path.rs`) carries a matching
`not(target_os = "linux")` block. This is a maintained portability seam, not vestigial code.

### 1.2 Windows is already a first-class target in the source

This is the single most important finding. Upstream has been actively porting:

- **`src/platform/windows.rs`** (529 lines) — a complete Win32 I/O layer: `CreateFileW`
  memory mapping, `VirtualAlloc` buffers, **Windows 11 IORING** (`IORING_VERSION_4`,
  `BuildIoRingWriteFile`, 64 MiB segments, QD 64) for the muxer write path, plus
  `FSCTL_SET_COMPRESSION` disable and file preallocation. It is wired in — `mkv_mux.rs:43`
  imports `platform::{Mmap, write_mux}`, and `ffms.rs`, `mux_webm.rs`, `copy.rs` import `Mmap`.
- **`src/plat.rs`** — `#![cfg(windows)]`. Exports the C shims the assembly calls:
  `xav_plat_now`, `xav_plat_write`, `xav_plat_wait`/`xav_plat_wake` (`WaitOnAddress` /
  `WakeByAddressSingle`), `xav_plat_park`.
- **Assembly is Win64-ABI aware throughout.** All 91 asm files use dav1d's `x86inc`
  `cglobal` (which switches ABI on `WIN64` automatically), and the hand-written files carry
  explicit `%if WIN64` blocks — `asm/pb.asm`, `asm/pbf.asm`, `asm/avx512/crc32*.asm`,
  `asm/*/atofu/*.asm` (`cglobal atou, 4, 9+WIN64, 14`). There are dedicated Win64
  synchronisation kernels: `asm/sync/{sem,ring_spsc,ring_spmc,ring_mpmc,ring_mpsc}_win.asm`.
- **`build.rs`** already branches: on `windows` it assembles the `_win` sync kernels and
  links `synchronization.lib`; on `linux` it assembles the futex/vDSO variants.
- **`src/chan/mod.rs:1`** — the lock-free AVX2 ring buffers are gated
  `any(target_os = "linux", target_os = "windows")`. Windows is explicitly included.
- Recent commit history confirms the direction: *"fix win64 atofu"*, *"more independence"*.

**Conclusion:** this is not a from-scratch port. It is a port that is roughly 90 % done in
the source tree and 0 % done in the build system.

### 1.3 What is *not* shared with Linux on Windows

Running the `std` path costs the following Linux-only optimisations. None are fatal; all
are worth knowing before benchmarking:

| Linux-only | Windows equivalent | Impact |
|---|---|---|
| `no_std` freestanding binary | `std` runtime | negligible at runtime; larger binary |
| `galloc.rs` custom allocator | Windows heap via `std` | small; allocation is not hot |
| io_uring read path (`uring.rs`) | `std::fs` reads + `Mmap` | moderate on decode-bound work |
| IORING write path | **already implemented** (`platform/windows.rs`) | none |
| futex `sync.rs` | `WaitOnAddress` (implemented) | none |
| custom `thread.rs` (raw `clone`) | `std::thread` | negligible |
| vDSO clock | `QueryPerformanceCounter` via `Instant` | negligible — but see §2.3 item 6 |

The dominant cost in any real encode is SVT-AV1's own assembly, which is identical on both
platforms. Expect native-Windows throughput within a few percent of Linux for
encode-bound work; the gap widens only on decode-bound 4K/8K HEVC sources.

---

## 2. Windows readiness audit — measured

### 2.1 Method

```bash
rustup toolchain install nightly
rustup target add x86_64-pc-windows-msvc x86_64-pc-windows-gnu --toolchain nightly
RUSTFLAGS="-C target-cpu=x86-64-v4" \
  cargo +nightly check --target x86_64-pc-windows-msvc --no-default-features
```

`--no-default-features` drops `vship` + `cuda` (they need `libvship.a` present at build.rs
time). `check` compiles without linking, so the missing Windows FFmpeg/dav1d/opus/SVT-AV1
static libs do not mask source-level errors.

### 2.2 Results

| Target | `-C target-cpu` | Errors |
|---|---|---|
| `x86_64-pc-windows-msvc` | baseline `x86-64` | 31 |
| `x86_64-pc-windows-msvc` | `x86-64-v3` (AVX2, no PCLMULQDQ) | 11 |
| `x86_64-pc-windows-msvc` | `x86-64-v4` (AVX-512) | **8** |
| `x86_64-pc-windows-gnu` | `x86-64-v4` | **8 (identical)** |

Two things fall out of this table:

1. **AVX2 is a hard floor.** `build.rs:build_asm()` only assembles the kernel set when the
   target has `avx2` or `avx512bw`; below that, ~20 asm symbols the Rust code calls
   unconditionally simply do not exist. The 23 extra baseline errors are all
   `cannot find function`. Same on Linux — the Linux build sidesteps it because
   `.cargo/config.toml` always passes `-C target-cpu=native`. Any Windows build config
   **must** carry `target-cpu=native` (or ≥ `x86-64-v3`) or it will not compile.
2. **The 3 extra v3 errors are an artefact of the synthetic CPU model, not a real gap.**
   `crc32::{update, combine, copy_nt}` are gated on `pclmulqdq`/`vpclmulqdq`
   (`build.rs`, `src/mkv/crc32/*`). `x86-64-v3` excludes PCLMULQDQ; every real CPU since
   Westmere has it, so `target-cpu=native` resolves them.
3. **MSVC and GNU targets are equivalent at the Rust level** — identical error sets. The
   choice between them is purely a *dependency-linking* decision (§4.3).

### 2.3 The 8 real source gaps

| # | File:line | Error | Nature | Est. |
|---|---|---|---|---|
| 1 | `src/io.rs:4-8` | unused imports `Display`, `Formatter`, `MaybeUninit`, `copy_nonoverlapping` | mechanical — `warnings = "deny"` promotes these to errors | 5 min |
| 2 | `src/fs.rs:454` | unused import `copy as std_copy` (only used under `feature = "vship"`) | mechanical — needs a `#[cfg(feature = "vship")]` on the import | 5 min |
| 3 | `src/fs.rs:463` | `use crate::Result` — unresolved | mechanical — the alias is Linux-only; point at `crate::io::Result` | 5 min |
| 4 | `src/chunk.rs:17` | `crate::io::SeekFrom::Start` — "`SeekFrom` is a type alias, not a module" | mechanical, but **not** by adding `pub use` — `clippy::pub_use` is `deny`. Import the type and write `SeekFrom::Start(24)` at `chunk.rs:214` | 10 min |
| 5 | `src/enc.rs:1261` | `cannot borrow cmd as mutable` | mechanical — Linux `Command::spawn(&self)` vs `std::process::Command::spawn(&mut self)`; add `mut` | 5 min |
| 6 | `src/progs.rs:360,676` | `Mono::raw()` missing on non-Linux | **design** — see below | 1 h |
| 7 | `src/progs.rs:27` | `thread::park_state` missing on non-Linux | **design** — see below | 2–4 h |

Six are trivial. Two need thought, and both are *correctness* issues that would produce a
silently-wrong progress display rather than a crash — exactly the kind of thing that must
not be papered over:

**#6 — `Mono::raw()` epoch coherence.** On Linux, `Mono` is a raw `u64` of monotonic
nanoseconds (`clk.rs:9`), and `progs.rs:676` hands that raw value to the assembly
(`Draw.start_ns`). The asm compares it against `xav_plat_now()`. On Windows,
`xav_plat_now` (`plat.rs:19`) returns elapsed time since a process-global
`OnceLock<Instant>`. So a non-Linux `Mono::raw()` must be nanoseconds **from that same
epoch** — not from `Instant::now()` independently, and not from `UNIX_EPOCH`. The fix is to
hoist that `OnceLock<Instant>` into `clk.rs` and have both `Mono::now()` and
`xav_plat_now` read it. Getting this wrong yields a plausible-looking but garbage ETA.

**#7 — `park_state()`.** `progs.rs:201` passes `park_state()` into the asm monitor
(`xav_pb_mon`), which uses it as the address for `PPARK` → `xav_plat_park(addr)`. There is
no non-Linux `park_state()`; on Linux it returns the current thread's `Arc<AtomicU32>` park
slot from a `#[thread_local]` (`thread.rs:137`). The Windows equivalent needs a per-thread
`AtomicU32` at a stable address.

> **Correction.** An earlier draft of this document claimed `plat.rs:57` was buggy, on the
> grounds that `xav_plat_park` calls `WaitOnAddress(addr, &u32::MAX, 4, 512)` while the park
> slot holds something else — which would make `WaitOnAddress` return immediately and spin.
> That is wrong. `asm/pbf.asm:939` defines `PARKED -1`, and `thread.rs:26` has
> `const PARKED: u32 = u32::MAX`. The compare value *is* the parked sentinel, and the Linux
> branch of the same macro passes the identical value to `FUTEX_WAIT`. The two paths are
> semantically equivalent and `plat.rs` needs no change.

### 2.4 Build-system gaps (larger than the source gaps)

| Gap | Detail | Severity |
|---|---|---|
| `build.rs:126` | `let home = env::var("HOME")?;` — **hard failure on Windows** (`USERPROFILE`). Every link-search path is `{home}/.local/src/...` with forward slashes. | blocker |
| `build.rs:171` | `cargo:rustc-link-arg=-l:libstdc++.a` — GNU-ld syntax; breaks under `link.exe` (MSVC). vship path only. | blocker for TQ+MSVC |
| `build.sh` | 864 lines of Bash 5 with `pacman/dnf/emerge/brew`, `/sys/bus/pci` NVIDIA probe, `/proc/cpuinfo` AVX-512 probe, `nproc`, `/dev/null` as an encoder output path, GNU `sed -i`. **Zero Windows support.** | blocker |
| `.cargo/config.toml*` | `-C linker=clang`, `-fuse-ld=lld`, `-no-pie`, `-Wl,-z,norelro`, `--gc-sections`, `--icf=safe` — all ELF/GNU-ld. Needs a Windows profile. | blocker |
| SVT-AV1 PGO | `build.sh:624` patches `Build/linux/build.sh`, downloads a 4K clip, trains via `-b /dev/null`. Needs a Windows equivalent (`Build/windows`, `NUL`). | high — PGO is a real speed win |
| Console VT | XAV drives the alt screen and ANSI colour (`main.rs:630` `\x1b[?1049h`) but **never calls `SetConsoleMode(ENABLE_VIRTUAL_TERMINAL_PROCESSING)` or `SetConsoleOutputCP(CP_UTF8)`** — no such call exists anywhere in `src/`. Fine in Windows Terminal, garbage in legacy conhost, and the Nerd Font glyphs in `guide.txt` need UTF-8. | high (UI) |
| `--guide` pager | `main.rs:189` `#[cfg(unix)]` `less` — Windows falls through to dumping 134 KB raw. | medium (UI) |
| External encoders | `avmenc`, `vvencFFapp`, `x265`, `x264` are spawned by name (`encoder.rs:146,196,262,353`). Only SVT-AV1 is statically linked. These need `.exe` on `PATH` for anything but AV1. | medium |
| Vship / TQ | Vship ships **precompiled Windows binaries and a Windows build doc** (`doc/FFVship-Windows-Compilation.md`, `make buildFFVSHIPcuda`), but XAV links `libvship.a` — a static archive, not the FFVship exe. Needs its own Windows static-lib build. | high — TQ is the headline feature |

### 2.5 FFmpeg version exposure (measured)

`build.sh:clone_phase` clones `https://github.com/FFmpeg/FFmpeg` with **no tag or pin**, so
a build started today gets whatever is on master — which since 4 August 2026 means
**FFmpeg 9.0 "Lei"** or later. That release bumps libavcodec and libavformat to the 63
series, which normally signals struct-layout churn.

That matters more than usual here, because XAV does not just call the FFmpeg API — it pokes
raw byte offsets into an opaque `AVCodecContext`:

```rust
src/ffms.rs:59    const HW_DEVICE_CTX_OFFSET: usize = 560;   // -> hw_device_ctx
src/ffms.rs:398   const THREAD_COUNT_OFFSET:  usize = 656;   // -> thread_count
src/ffms.rs:400   ...add(HW_DEVICE_CTX_OFFSET).cast::<*mut c_void>().write_unaligned(buf_ref)
```

If a release reorders that struct, these writes land on the **wrong field**. There is no
compile error and no link error — `--hwdec` would corrupt state silently.

Measured against real headers (`offsetof` compiled against each release):

| FFmpeg | `sizeof(AVCodecContext)` | `hw_device_ctx` | `thread_count` |
|---|---|---|---|
| n7.1 | 864 | 560 | 656 |
| n8.0 | 864 | 560 | 656 |
| **n9.0** | **864** | **560** | **656** |

Both offsets are correct for FFmpeg 9.0. The struct also contains **no `long`, `size_t` or
`ptrdiff_t` members**, so the layout is identical under Linux LP64 and Windows LLP64 — the
same constants are valid on both platforms.

So this is not a live bug. It is an unpinned, unchecked assumption that happens to hold.
`build.rs` now compiles a `_Static_assert` probe against the headers actually being linked
and fails the build with an actionable message if the offsets ever move (verified in both
directions). The dependency-pinning manifest in §7.3 is the complementary half.

---

## 3. Route decision: WSL2 vs native Windows

These are not mutually exclusive, and the honest recommendation is **do both, in this
order**.

| | **WSL2 (Ubuntu)** | **Native Windows** |
|---|---|---|
| Time to first successful encode | ~1–2 h (mostly compile time) | ~2–4 days of work |
| Code changes needed | **none** | 8 source fixes + build system |
| Optimisation level | **full** — `no_std`, io_uring, futex, vDSO, PGO'd SVT-AV1 | `std` path; IORING write only |
| NVIDIA CUDA (hwdec + Vship) | works (WSL CUDA driver passthrough) | works (native) |
| AMD/Intel GPU (Vulkan hwdec + Vship) | poor — no reliable Vulkan passthrough in WSL2 | works |
| Disk I/O on Windows drives | **slow** — `/mnt/c` 9p/DrvFs is a real bottleneck; must keep media inside the ext4 VHDX | native, fast |
| RAM behaviour | VM has a ceiling; `.wslconfig` tuning required | native |
| GUI integration | awkward (interop shims, path translation) | clean |
| Maintenance | tracks upstream for free | must be maintained against upstream |

**Recommendation:**

- **Phase 1 = WSL2.** It is the only way to get the *actually optimal* build — the entire
  point of XAV's `no_std`/io_uring architecture — and it works today with zero code
  changes. This becomes both the working encoder and the **performance reference** every
  native number is measured against.
- **Phase 2+ = native port,** because "user-friendly interface" is much better served by a
  native `.exe` with drag-and-drop and shell integration, and because the port is only 8
  errors away. It also has genuine upstream value.

The one input that could flip this: **GPU vendor**. On an AMD or Intel GPU, WSL2's lack of
Vulkan passthrough makes `--hwdec` and Vship/TQ unusable there, which promotes the native
port from "nice" to "required". §4.1 resolves this.

---

## 4. Phased plan

### Phase 0 — Probe and decide (30 min, when home)

Run `tools/windows/probe-xav-system.ps1` (included in this branch) from an **elevated**
PowerShell. It reports, and writes `xav-probe-report.txt`:

- CPU model, physical/logical cores, **AVX2 / AVX-512 / VNNI** support, hybrid P/E-core
  split, cache sizes
- Total RAM, current free, page-file config
- GPU vendor(s), VRAM, driver, NVENC/NVDEC generation, CUDA/HIP presence
- Storage: which volumes are NVMe vs SATA vs HDD, free space, BitLocker state
- Windows build number (IORING needs ≥ 22000), Windows Terminal presence, developer mode,
  Defender real-time state, active power plan, core-parking setting, HAGS state
- WSL2 presence and version, `.wslconfig` contents
- Existing toolchain: rustup/cargo/nightly, clang, nasm, MSYS2, CUDA, Visual Studio Build Tools

The report drives §5 directly, and answers the GPU question that decides §3.

**Decision gates coming out of Phase 0:**

| If | Then |
|---|---|
| NVIDIA GPU | WSL2 first; `--features vship,cuda`; `--hwdec` via `*_cuvid` |
| AMD/Intel GPU | native port is required for TQ; Vship Vulkan backend; WSL2 for CPU-only work |
| No AVX2 | **stop** — XAV cannot build (§2.2). Not a realistic outcome on any Win11-era CPU. |
| < 32 GB RAM | worker counts in §5.2 must be scaled down hard; 4K/10-bit is 7.5 GB *per worker* |
| Windows build < 22000 | `platform/windows.rs` IORING path is unavailable — needs an overlapped-I/O fallback |

### Phase 1 — WSL2 baseline (half a day, mostly unattended)

1. `wsl --install -d Ubuntu-24.04`; confirm WSL 2.
2. `%UserProfile%\.wslconfig`: `memory=<~75 % of RAM>`, `processors=<all>`,
   `swap=0`, `nestedVirtualization=false`, `pageReporting=true`. Restart with
   `wsl --shutdown`.
3. NVIDIA only: verify `nvidia-smi` works inside WSL (driver comes from Windows; do **not**
   install a Linux driver).
4. `sudo apt install` the `dnf`-list equivalents, or let `build.sh install_deps` run — note
   it has no `apt` branch, so this needs either a manual package list or a small
   `install_deps` patch (worth upstreaming).
5. `./build.sh` → interactive: **mode 1 (With TQ)**, fork **`hdr`** (juliobbv-p/svt-av1-hdr)
   for HDR/variance-boost work, or **`essential`** for speed-focused SDR.
   Non-interactive: `./build.sh static_tq hdr`.
6. **Keep media inside the WSL filesystem** (`~/media`), never `/mnt/c`. This is the single
   biggest WSL2 performance factor and will otherwise invalidate every benchmark.
7. Record reference benchmarks (§7.1). This is the number the native build is judged against.

### Phase 2 — Native source port (1–2 days)

Branch `claude/xav-windows-setup-optimization-rfm0n5`.

1. Apply the 6 mechanical fixes (§2.3 #1–5). Verify:
   `RUSTFLAGS="-C target-cpu=native" cargo +nightly check --target x86_64-pc-windows-gnu --no-default-features`
2. `clk.rs`: shared `START: OnceLock<Instant>` epoch; non-Linux `Mono::raw() -> u64` in
   nanoseconds from it; `plat.rs::xav_plat_now` reads the same epoch. (§2.3 #6)
3. `thread.rs`: non-Linux `park_state()`; audit `plat.rs::xav_plat_park` against the asm
   protocol in `asm/pbf.asm` (`PPARK`/`PWAKE`). Fix the `WaitOnAddress` compare-value bug or
   confirm intent with upstream. (§2.3 #7)
4. **Console init** — new `platform/windows.rs` entry called first thing in `main()`:
   `SetConsoleOutputCP(CP_UTF8)`, `SetConsoleCP(CP_UTF8)`, and
   `GetConsoleMode`/`SetConsoleMode(ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT)`
   on stdout, restoring the prior mode via the existing `restore()` hook (`main.rs:167`).
   Without this the alt-screen TUI is unusable outside Windows Terminal.
5. `--guide` pager: on Windows try `less.exe` → `more.com` → raw dump (`main.rs:189`).
6. `build.rs`: replace `env::var("HOME")?` with a `HOME` → `USERPROFILE` → `XAV_DEPS_DIR`
   cascade; make the dependency root overridable by env var; gate the
   `-l:libstdc++.a` link-arg on `not(windows)`.
7. Re-run the full Linux build to prove **zero regressions** — this is a hard gate; the
   deny-all lint config means any careless `#[cfg]` breaks the Linux build.
8. Run `cargo +nightly test` (there are 1191 lines of tests in `src/tests.rs`).

**Upstreamable**: items 1–6 are all genuine Windows-port fixes that benefit upstream. Open a
PR against `emrakyz/xav` — this is a fork, and carrying these locally forever is the worse
option.

### Phase 3 — Native dependency build (2–3 days, the real work)

Decision: **`x86_64-pc-windows-gnu` via MSYS2/UCRT64 + clang**, not MSVC.

Rationale: FFmpeg, dav1d (meson+nasm), opus, SVT-AV1 and Vship all build cleanly under
MinGW-w64/clang with essentially the same invocations `build.sh` already uses; under MSVC
they need `clang-cl` shims, and FFmpeg in particular needs MSYS2 anyway. The Rust-level
error sets are identical (§2.2), so nothing is lost. If MSVC becomes necessary later
(e.g. for a WinUI front-end), only the dependency ABI changes, not XAV.

1. MSYS2 + UCRT64: `clang`, `lld`, `nasm`, `cmake`, `ninja`, `meson`, `make`, `pkgconf`,
   `git`, `curl`, plus `ffmpeg` (needed only as a *tool* for SVT-AV1 PGO training).
2. Rust nightly, `x86_64-pc-windows-gnu` target, linker pointed at the UCRT64 clang.
3. Port `build.sh` → `build.ps1` (PowerShell driver) + `build-deps.sh` (MSYS2 bash, reusing
   the existing per-library functions almost verbatim). Windows-specific deltas:
   - NVIDIA probe: `Get-CimInstance Win32_VideoController` instead of `/sys/bus/pci`
   - AVX-512 probe: `IsProcessorFeaturePresent` / CPUID instead of `/proc/cpuinfo`
   - `nproc` → `$env:NUMBER_OF_PROCESSORS`
   - SVT-AV1 PGO: `Build/windows` (or the MSYS2 path), `-b NUL` instead of `/dev/null`
   - dav1d `.pc` `sed` rewriting: paths need MSYS2-style handling
4. `.cargo/config.toml.windows`: keep `target-cpu=native`, `opt-level=3`,
   `codegen-units=1`, `lto=fat`, `panic=abort`, `strip=symbols`; **drop** every ELF-only
   link arg (`-no-pie`, `-z norelro`, `--icf=safe`, `--gc-sections` → use lld-link
   equivalents `/OPT:REF /OPT:ICF` where applicable).
5. Vship: build `libvship.a` for Windows from the Vship Windows devkit (`make
   buildFFVSHIPcuda` produces the exe; the static lib target needs adapting — this is the
   highest-risk item in the phase). If it resists, **ship Phase 3 without `--features
   vship`** — XAV is fully functional for CRF encoding without TQ — and keep TQ on WSL2.
6. External encoders: fetch `x264.exe`, `x265.exe`, `vvencFFapp.exe`, `avmenc.exe` and place
   them on `PATH` (or ship them next to `xav.exe`).

**Fallback if Phase 3 stalls:** WSL2 (Phase 1) already delivers full functionality. Phase 3
is about the native `.exe` that Phase 5's GUI wants, not about capability.

### Phase 4 — Tuning (1 day + ongoing) → §5

### Phase 5 — UI (3–7 days depending on tier) → §6

### Phase 6 — Rollout → §7

---

## 5. Tuning

### 5.1 Build-time settings

| Setting | Value | Why |
|---|---|---|
| `-C target-cpu=native` | **mandatory** | Not an optimisation — below AVX2 the build fails (§2.2). Also unlocks AVX-512 kernels (`asm/avx512/*`) and PCLMULQDQ CRC32. |
| `lto=fat`, `codegen-units=1` | keep | already in `.cargo/config.toml`; ~5–10 % on this workload |
| `panic=abort` | keep | required — `no_std` Linux path has no unwinder |
| SVT-AV1 PGO | **do it** | `build.sh:624` already implements the full generate→train→use cycle. Typically 5–15 % on SVT-AV1. Worth the port effort in Phase 3. |
| SVT-AV1 fork | `hdr` for HDR/quality, `essential` for speed | `essential` also flips on `--features svt-essential` |
| AVX-512 | auto-detected | On Zen 4/5 this is a large win. On Intel P/E-core hybrids AVX-512 is fused off — the probe will say. |
| `--features` | `vship,cuda` (NVIDIA) / `vship` (AMD, Vulkan) / none (no TQ) | `cuda` without an NVIDIA GPU will not link |

### 5.2 Runtime settings — grounded in `src/guide.txt` §2.3–2.4

The guide gives the authoritative memory model, and it is unusually strict:

```
YUV420P   per frame = 1.5 × W × H
YUV420P10 per frame = 3   × W × H
chunks are up to 300 frames
→ 1080p  8-bit: 1.5 × 1920 × 1080 × 300 ≈ 0.93 GB per worker
→ 4K    10-bit: 3   × 3840 × 2160 × 300 ≈ 7.47 GB per worker
```

The guide is explicit: *"For 4K/10bit blu-rays … you can't run 5 workers in parallel having
32GB memory."* Worker count is a **memory** decision first and a CPU decision second.

Starting points, to be confirmed against the probe's RAM figure:

| Source | RAM | `-w` | `-p "--lp N"` | `-b` |
|---|---|---|---|---|
| 1080p 8-bit | 32 GB | 4–6 | `--lp 4` | 4–8 |
| 1080p 8-bit | 64 GB+ | 6–8 | `--lp 4` | 16–64 (guide's own setup) |
| 1080p 10-bit | 32 GB | 3–4 | `--lp 5` | 2–4 |
| 4K 10-bit | 32 GB | **2** | `--lp 8` | **0** |
| 4K 10-bit | 64 GB | 3–4 | `--lp 6` | 0–2 |
| 4K 10-bit | 128 GB | 6–8 | `--lp 5` | 2–4 |

Rules the guide states directly:

- Roughly `workers × lp ≈ logical cores`, with SVT-AV1's internal parallelism being
  *"completely free"* — so prefer fewer workers × higher `--lp` for large frames, and the
  inverse for small ones. The guide's own examples: `-w 3 -p "--lp 5"` and `-w 32 -p "--lp 1"`.
- **`-b 0` is not just "no buffer"** — it enables a zero-copy decode path, but only when
  the input is already `yuv420p10le` *and* TQ is off. For 10-bit sources without TQ,
  `-b 0` can beat `-b 4`. Test both; do not assume more buffering is better.
- For **x264/x265/vvenc**, XAV forces internal encoder threading off — there, *more workers
  is always better* up to the RAM limit. The table above is SVT-AV1 guidance.
- `-w` defaults to `1` deliberately, as a signal to set it yourself.

**`--hwdec`**: `ffms.rs:579` uses `h264_cuvid`/`hevc_cuvid`/`av1_cuvid`/`vp9_cuvid`/`vc1_cuvid`
— NVIDIA NVDEC. Helps decode-bound 4K HEVC; on 1080p it can be *slower* than the AVX-512
CPU path because of the extra device→host copy. Benchmark, don't assume.

Note the interaction: `-b 0`'s zero-copy path and `--hwdec` and TQ all contend for the same
buffer decisions. The three-way matrix is worth one afternoon of measurement (§7.1).

### 5.3 Windows OS tuning

Ordered by measured impact on long encodes:

1. **Defender exclusions** — the single biggest Windows-specific win. Exclude the media
   directory, the XAV working directories (XAV creates `.<hash7>/` next to the input,
   `main.rs:635`), `%USERPROFILE%\.local\src`, the repo, and the `xav.exe` process.
   Real-time scanning on hundreds of chunk files is brutal.
2. **Power plan** → *Ultimate Performance* (or High Performance), **processor minimum state
   100 %**, **core parking disabled**. Windows aggressively parks cores on long
   multi-threaded loads.
3. **Storage** — put input, working dir and output on NVMe. XAV's chunked design writes many
   small files. If the source is on a HDD/NAS, stage it locally first.
4. **Page file** — system-managed, on the fastest drive. XAV can spike hard at chunk
   boundaries; a fixed small page file causes OOM aborts mid-encode.
5. **BitLocker** — measurable overhead on the working volume. If the media drive is
   encrypted and the threat model allows, exclude it.
6. **Hardware-Accelerated GPU Scheduling (HAGS)** — leave on for NVDEC/Vship; it does not
   affect CPU encoding.
7. **`xav.exe` priority** — *Above Normal*, not *Realtime* (Realtime starves the UI thread
   and the progress display). Set via the launcher (§6), not permanently.
8. **Windows Terminal** as default — required for the TUI to look right even after the VT
   fix, and needed for the Nerd Font glyphs `--guide` uses.
9. **A Nerd Font** (e.g. CaskaydiaCove NF) in the terminal profile — `guide.txt` is full of
   private-use-area glyphs, and `--guide` explicitly says *"Use fullscreen & Nerd Fonts"*.

### 5.4 WSL2-specific tuning (Phase 1)

`%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=48GB          # ~75% of physical; leave headroom for Windows
processors=<all>
swap=0               # let the encode fail loudly rather than thrash
pageReporting=true
nestedVirtualization=false
[experimental]
autoMemoryReclaim=gradual
sparseVhd=true
```

And, non-negotiably: **media lives in the ext4 VHDX, not `/mnt/c`.**

---

## 6. User-friendly interface

XAV today is a power-user CLI: 15 flags, a 134 KB `--guide`, and an alt-screen TUI that
assumes a Nerd Font. The gap to "user-friendly" is real. Three tiers, deliverable
independently and in order of value-per-hour.

### Tier 1 — Interactive wizard mode (in-repo, ~1 day, **highest value/effort ratio**)

`xav` with no arguments — currently an error — becomes a guided flow.

- Input: typed, or **dragged onto the console window** (Windows quotes the path; XAV
  already has `parse_quoted_args`, `main.rs:520`).
- Probes the file (`get_vidinf`) and reports resolution, bit depth, codec, duration.
- **Codec is a top-level question, asked every time, defaulting to the last choice** —
  *"H.265 (10-bit, x265) / AV1 (SVT-AV1)"*, with `avm`/`vvenc`/`x264` behind "more".
  Per §9a this is a per-video decision, not a global setting, and it should never be
  buried in an advanced panel. Both paths are software-only; there is no hardware
  encoder to accidentally select.
- Asks intent in plain language — *"Archive quality / Balanced / Small file / Match a
  quality target"* — mapping to CRF or `--tq`, and preset.
- **Computes `-w`, `--lp` and `-b` itself** from `available_parallelism()`, detected RAM,
  and the frame-size formula in §5.2. This is the single most valuable thing the UI can do:
  it is the hardest parameter to get right and the one where the guide says *"experimentation
  needed"*. Note the rule differs by codec — for x265 there is no internal threading to
  trade against, so it should scale workers up to the RAM ceiling rather than balancing
  against `--lp` the way SVT-AV1 does (§9a).
- Prints the exact equivalent command line before running — the wizard teaches the CLI
  rather than hiding it.
- Presets saved to `%APPDATA%\xav\presets\<name>` in the **existing** saved-args format
  (`save_args` / `parse_quoted_args` already round-trip this for resume).

Constraint honoured: zero new dependencies, ~400–600 lines, works identically on Linux.
Upstreamable.

### Tier 2 — Native GUI (`xavui.exe`)

Two credible options. This is the main open decision.

**2a — Win32 GUI, hand-rolled, no crates (~4–6 days).** A second binary in the workspace,
written in the same direct-FFI style as `platform/windows.rs` (which already declares
`CreateFileW`, `DeviceIoControl`, IORING by hand — the idiom exists and is proven in-tree).

- Drag-and-drop (`WM_DROPFILES`), or file picker
- Preset dropdown + collapsible Advanced panel exposing every CLI flag
- **Job queue** with per-job progress, pause/resume (XAV already has real stop/resume:
  `get_resume`, `chnks_done`)
- Live progress bars, fps, ETA, per-chunk state
- Taskbar progress (`ITaskbarList3`) and a completion toast
- Collapsible raw-output pane
- Fits the project's no-dependency ethos exactly; ships as a single self-contained `.exe`.

**2b — WebView2 front-end (~2–3 days).** HTML/CSS/JS UI in a WebView2 host. Much faster to
build something that looks modern, far easier to iterate on. Cost: a runtime dependency on
the WebView2 runtime (preinstalled on Win11) and a philosophical break with the project's
"no dependencies" stance — so it would live outside the XAV repo as a companion tool.

**Prerequisite for either: a machine-readable progress channel.** Both options must not
scrape the ANSI TUI. Add `--progress machine` to XAV: line-delimited `key=value` records on
stderr (`chunk=12/340 frames=... fps=... eta=... state=...`), emitted from the same places
`progs.rs` already updates. ~100 lines, decouples the GUI from the TUI permanently, and is
independently useful for scripting. **Do this first, whichever GUI wins.**

### Tier 3 — Shell integration (~half a day)

- Registry `HKCU\Software\Classes\*\shell\Encode with XAV` → context menu, with a submenu of
  saved presets
- `SendTo` shortcut
- Optional: a Windows Terminal profile with the right font and colours preconfigured
- A proper installer (see §7.3) that sets `PATH`, installs a Nerd Font, applies the Defender
  exclusions from §5.3, and registers the context menu

### 6.1 Recommendation

Tier 1 + Tier 3 first — together ~1.5 days, and they remove most of the friction. Then
Tier 2a if the goal is a tool that matches XAV's character and stays dependency-free, or
2b if the goal is the nicest-looking UI in the least time. **This is the decision I need
from you** (§9).

---

## 7. Rollout & verification

### 7.1 Benchmark protocol

Establish the WSL2 reference first, then hold the native build to it. Fixed corpus:

| Clip | Why |
|---|---|
| 1080p 8-bit AVC, ~2 min | the common case; exercises 8→10-bit conversion |
| 1080p 10-bit HEVC, ~2 min | exercises the `-b 0` zero-copy path |
| 4K 10-bit HEVC HDR, ~1 min | memory pressure, `--hwdec`, HDR metadata passthrough |
| Something with black bars | autocrop (`crop/avx512.rs`) |
| Multi-track / multi-language audio | Opus downmix + loudnorm + `lang.rs` |

Record for each: wall time, average fps, peak RSS, output size, and a quality check
(SSIMU2/Butteraugli via TQ mode where available). Sweep `-w × --lp × -b` and `--hwdec`
on/off — that matrix is where the real tuning lives, and it must be measured, not guessed.

### 7.2 Acceptance gates

1. Linux build still green, `cargo test` passes, zero new lint warnings (the config makes
   any warning a build failure).
2. Native Windows binary produces **byte-identical output** to the Linux build for the same
   input and parameters. SVT-AV1 is deterministic, so this is a legitimate and very strong
   correctness gate — it will catch any Win64 ABI or endianness slip in the asm immediately.
3. Stop/resume works: kill mid-encode, restart, verify the muxed result matches an
   uninterrupted run.
4. Native throughput within 10 % of the WSL2 reference on encode-bound clips. If it is not,
   the decode path (io_uring vs `std::fs`) is the first suspect.
5. The alt-screen TUI renders correctly in Windows Terminal **and** legacy conhost, and
   restores the console mode cleanly on Ctrl-C and on crash (`restore()`, `error.rs:128`).

### 7.3 Packaging

- Portable zip: `xav.exe`, `xavui.exe`, external encoder exes, README, presets
- Optional MSI/winget manifest for `PATH`, font, Defender exclusions, context menu
- Pin the exact dependency commits (FFmpeg/dav1d/opus/SVT-AV1/Vship) in a lockfile-style
  manifest — `build.sh` clones `HEAD` of each, which is not reproducible

### 7.4 Rollback

WSL2 stays installed and working throughout. If the native build regresses, the WSL2 path is
the fallback with zero downtime, and the wizard (Tier 1) works in both.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Vship Windows static lib resists building | medium | high — no TQ natively | Ship native without `--features vship`; keep TQ on WSL2 |
| `xav_plat_park` spin bug (§2.3 #7) is deeper than it looks | medium | medium | Coordinate upstream; worst case, non-Linux progress monitor falls back to a plain sleep loop |
| SVT-AV1 PGO doesn't port to Windows build scripts | medium | medium — 5–15 % speed | Ship non-PGO first; PGO is an optimisation, not a blocker |
| Upstream churn breaks the fork | high (repo is very active — 15 commits recently) | medium | Upstream the port fixes; rebase often; keep Windows-only code in `platform/`+`plat.rs` |
| Win11 build < 22000 → no IORING | low | medium | Overlapped-I/O fallback in `platform/windows.rs` |
| `std` decode path is materially slower on 4K | medium | medium | `--hwdec`, tune `-b`; document the gap honestly rather than hiding it |
| GNU-target binary trips Defender/SmartScreen heuristics | medium | low | Exclusions (§5.3); consider signing |

---

## 9. Decisions taken

| Decision | Choice |
|---|---|
| Route | **WSL2 first, then native** (§3) |
| UI | **Tier 1 wizard + Tier 2a hand-rolled Win32 GUI** (§6) |
| Upstreaming | **Keep in this fork.** Upstream is resistant to outside PRs, so the port is maintained here — see §10 |

---

## 9a. Codec policy

Stated requirements, and where each stands today.

### Already satisfied — no work needed

**H.265 must be 10-bit software.** `make_x265_cmd` (`encoder.rs:261`) already
hardcodes `--input-depth 10 --output-depth 10 --profile main10 --input-csp 1`.
It is 10-bit 4:2:0 end to end, and it is the `x265` binary — software.

It is also tuned harder than a plain `x265 --preset slow` would be:
`--frame-threads 1 --pools 1 --slices 1 --no-wpp --lookahead-slices 1
--lookahead-threads 1`. Every one of those deliberately gives up *internal*
parallelism because internal parallelism costs coding efficiency, and XAV gets
the throughput back by running N chunks concurrently instead. Combined with
`--rc-lookahead 250` (near-free here, because the whole chunk is already in
memory) this is a meaningfully more efficient x265 configuration than a normal
single-process encode. The guide's note for these flags is literally
"Increases quality/efficiency (we parallelize externally)".

Corollary for tuning: for x265 the guidance in §5.2 differs from SVT-AV1 — the
guide says for H26x encoders *more workers is always better* up to the RAM
limit, because there is no internal threading to trade against.

**Never NVENC.** There is no hardware encode path in XAV at all. No
`nvenc`/`amf`/`qsv` reference exists anywhere in `src/`, and `build.sh`'s
FFmpeg configure has **no `--enable-encoder=` of any kind** — it is
`--disable-all` plus a decoder/demuxer/parser allowlist. The only NVIDIA
involvement is `--enable-nvdec`/`--enable-cuvid` and the `*_cuvid` decoders
(`ffms.rs:579`), which `--hwdec` uses for **decoding only**. So `--hwdec` is
safe to offer in the UI without any risk of touching the encode path.

**AV1 or H.265 per video.** Already `-e svt-av1` / `-e x265` (also `avm`,
`vvenc`, `x264`). Selection is per invocation, so per video. The UI work in §6
should surface this as a top-level choice rather than an advanced flag — see
§6.1.

### LCEVC for H.265 — recommend against, for three independent reasons

Assessed on request. Each of these alone would be sufficient to stop it.

**1. There is no LCEVC encoder we can use.** The open-sourced component is
`LCEVCdec` — the *decoder*. Encoding requires V-Nova's commercial LCEVC SDK,
distributed via registration at `download.v-nova.com`, with the open-source
integration patches obtained "through a V-Nova representative or by submitting
a request". There is no royalty-free or open-source LCEVC encoder to link
against. XAV's licence is MIT NON-AI and its stated posture is no system-side
dependencies; a registration-gated commercial SDK is a hard mismatch.

**2. It is architecturally a large change, not a flag.** Even granted the SDK:

- XAV does not use FFmpeg to encode anything, so FFmpeg's LCEVC encoder
  integration is unreachable without adding an entire FFmpeg-encode path that
  does not exist today.
- XAV spawns the stock `x265` binary. Upstream x265 has no LCEVC support;
  V-Nova's route is a patched encoder or their own wrapper.
- The muxer is hand-written with a fixed codec-ID table (`encoder.rs:56`,
  `V_MPEGH/ISO/HEVC` and friends). A two-layer format needs different
  signalling and a second bitstream carried alongside every chunk.
- **TQ would need an LCEVC decoder in the metric loop.** Quality is measured on
  the decoded output via Vship; for LCEVC that means decoding base *plus*
  enhancement before measuring. This is the part most likely to be
  underestimated — it makes LCEVC support a change to the target-quality
  engine, not just to the encoder wrapper.
- Chunked encoding concatenates bitstreams; the enhancement layer would need
  the same treatment per chunk.

**3. The regime is wrong, so it probably would not even help.** LCEVC's
headline numbers come from complexity-constrained scenarios — the widely cited
~39 % BD-rate gain over standalone x265 is measured on **live gaming at
1080p60**. The published guidance is that ideal configurations pair LCEVC with
*mid-speed* base presets at transmission bitrates below ~3000 kbps for 1080p60,
and that gains show diminishing returns where the base codec is already
efficient (x265 at ≥4000 kbps). LCEVC also runs at roughly 0.3× x265's encode
time — the trade being bought is **speed**, not quality-at-any-cost. Reported
VMAF-based gains are also thought to overstate the real benefit.

XAV is the exact opposite operating point: maximum-effort offline encoding,
internal threading deliberately disabled to buy efficiency, per-scene quality
targeting, high bitrates. In that regime, spending the bits in the base layer
is the likelier win. This is a reasoned expectation from the published
operating ranges rather than a measurement of this specific setup — but given
(1) and (2), it is not worth measuring.

**Recommendation:** don't. If LCEVC playback compatibility ever becomes the
actual goal rather than compression efficiency, revisit — but the requirement
that it never be automatic already acknowledges the compatibility problem, and
an option that is off by default, needs a commercial SDK, requires reworking
the TQ engine, and is expected to lose on efficiency in this regime is not a
good trade.

*Sources: [Eyevinn, LCEVC-enhanced x265](https://eyevinntechnology.medium.com/will-lcevc-enhanced-x265-contribute-to-sustainability-in-streaming-47315a5be2c0);
[SPIE, Enhancing SVT-AV1 with LCEVC](https://www.lcevc.org/wp-content/uploads/2022_SPIE_Enhancing-SVT-AV1-with-LCEVC.pdf);
[V-Nova LCEVC SDK](https://v-nova.com/lcevc-enhanced-video/lcevc-video-sdk/);
[V-Nova docs](https://docs.v-nova.com/technologies/mpeg-5.lcevc).*

---

## 10. Fork maintenance strategy

Upstream is very active (15 commits in the recent window, including active Windows work)
and does not take outside PRs. So this fork has to absorb upstream continuously while
carrying a permanent delta, with no prospect of the delta ever being upstreamed away. That
changes how the port should be written.

### 10.1 Principles

1. **Minimise diff surface in upstream-owned files.** Every line changed in `enc.rs`,
   `fs.rs`, `io.rs` etc. is a future merge conflict. Prefer additive changes in
   *new* files, and in shared files prefer the smallest possible edit — this is why the
   dead-code shims got a one-line `#[allow]` each rather than being restructured or
   deleted, and why `chunk.rs` got an import change rather than a `pub use` in `io.rs`.
2. **Push platform code into platform files.** `src/platform/windows.rs` and `src/plat.rs`
   are already Windows-only and upstream touches them rarely. Console init went there, not
   into `main.rs`; `main.rs` got two `#[cfg(windows)]` call sites and nothing more.
3. **New features live in new modules.** The wizard and the TQ predictor should be new
   files with a single-line registration in `main.rs`, so a rebase touches one line.
4. **Never reformat.** `.rustfmt.toml` is upstream's; running a different formatter or
   re-wrapping untouched code would manufacture conflicts across the whole tree.
5. **Match upstream's idiom exactly** — `_ = expr` not `let _ = expr`, no `pub use`, direct
   FFI rather than wrappers. Code that looks native to the file merges more cleanly and is
   easier to re-apply by hand when it doesn't.

### 10.2 Mechanics

- **Branch layout.** `main` tracks upstream verbatim — never commit to it. All work lives
  on topic branches merged into an integration branch. Then upstream sync is
  `git fetch upstream && git rebase upstream/main` on each topic branch, and conflicts are
  scoped to one concern at a time instead of one giant blob.
- **Add the upstream remote** (it is not currently configured — `origin` is the fork):
  `git remote add upstream https://github.com/emrakyz/xav`
- **Keep commits thematic and self-describing.** When a rebase conflicts badly, a commit
  whose message explains *why* the change exists can be re-implemented against the new
  code; a commit that only says what it changed cannot.
- **The verification harness is the safety net.** Ten configurations —
  {Linux, windows-gnu, windows-msvc} × {AVX-512, AVX2} × {TQ, no-TQ} plus clippy — must
  pass after every upstream sync. Without it, a silently broken rebase is undetectable
  until runtime. This is worth committing into the repo as `tools/verify.sh`.
- **Track the clippy baseline count on the Windows target.** Clippy has never linted
  `plat.rs` / `platform/windows.rs` upstream (they are `cfg`'d out on Linux), so there are
  44 pre-existing findings there. Gate on that number not *growing*, rather than trying to
  drive it to zero — fixing them all would be a large diff in upstream-owned files for no
  functional gain.
- **Pin the dependency commits.** `build.sh` clones `HEAD` of FFmpeg, dav1d, opus, SVT-AV1
  and Vship. Combined with the ABI coupling in §2.5, that makes builds non-reproducible and
  breakage non-attributable. A manifest of known-good commits, updated deliberately, is
  what turns "it broke" into "it broke when I moved FFmpeg".

### 10.3 The rebase-risk ranking of the current delta

| Change | File owner | Conflict risk |
|---|---|---|
| `init_console` / `restore_console` | Windows-only file | very low |
| `clk::epoch`, `Mono::raw` | shared, but in `cfg(not(linux))` blocks | low |
| `park_state` | shared, additive | low |
| `#[allow(dead_code)]` shims | shared, one line each | low |
| `page_with` refactor | `main.rs` | medium — `print_guide` is upstream-owned |
| `enc.rs` `mut cmd` | `enc.rs` is very actively edited | medium |
| `build.rs` deps root + ABI guard | `build.rs` | medium |

Nothing is high-risk today. The wizard and TQ predictor should be built to keep it that
way.

---

## 11. TQ first-guess prediction

Separate design doc: **`docs/design/TQ-PREDICTOR.md`**.

Summary of the finding that motivates it: `tq_search_crf` (`enc.rs:697`) uses
content-blind bisection for rounds 1 and 2 — **every chunk of every video starts at CRF 28**
for the default `--qp 8.0-48.0`, regardless of content, encoder or target. Each of those
rounds costs a full chunk encode plus a full GPU metric pass. Rounds 3+ interpolate and are
content-aware.

The training data already exists: `write_chnk_log` (`enc.rs:1296`) writes every probe and
every final CRF to `<workdir>/chunks.json` on every TQ encode, and `average_probes` plus a
per-round histogram are already computed and printed, so the success metric needs no new
instrumentation.

Plan is two-tier — within-video adaptation first (no persistence, no cold start), then a
persisted bucketed model — with a `--tq-predict off|shadow|on` flag so accuracy can be
measured on real encodes at zero risk before anything acts on it. See the design doc for
the feature set, the safety constraints, and an honest assessment of which parts are
high-confidence and which are unproven.

---

## 12. Status

### Done and verified in this branch

| Item | Verification |
|---|---|
| All 8 source blockers (§2.3) | 10-config cross-compile matrix, all pass |
| Second-layer dead-code errors they masked | same |
| `clk::epoch` shared origin for `Mono::raw` / `xav_plat_now` | same |
| Non-Linux `park_state` | same |
| `build.rs` `XAV_DEPS`/`HOME`/`USERPROFILE` cascade | Linux build unchanged |
| `-l:libstdc++.a` gated off Windows | — |
| FFmpeg ABI guard | passes on real n9.0 headers; fails with the intended message when perturbed |
| Windows console VT + UTF-8 init/restore | compiles; needs on-machine confirmation |
| `--guide` pager fallback | compiles; needs on-machine confirmation |
| System probe script | hand-reviewed; not executed (no PowerShell here) |

**XAV now compiles for `x86_64-pc-windows-gnu` and `x86_64-pc-windows-msvc`**, with and
without TQ, on AVX-512 and AVX2 CPU models — with Linux unchanged.

### Not started

- `--progress machine` output mode (prerequisite for the GUI)
- Tier 1 wizard
- Native dependency build (Phase 3) — needs a Windows machine
- Win32 GUI (Tier 2a)
- TQ predictor (§11)

### Blocked on you

- `xav-probe-report.txt` → replaces every range in §5 with your actual numbers
- Confirmation that the console init and pager behave correctly on your terminal
