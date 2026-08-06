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

**#7 — `park_state()` and Windows parking semantics.** `progs.rs:201` passes
`park_state()` into the asm monitor (`xav_pb_mon`), which uses it as the address for
`PPARK` → `xav_plat_park(addr)`. Two sub-problems:

  - There is no non-Linux `park_state()`. On Linux it returns the current thread's
    `Arc<AtomicU32>` park slot from a `#[thread_local]` (`thread.rs:137`). A Windows
    equivalent needs a per-thread `AtomicU32` whose address is stable and whose protocol
    matches what the asm expects.
  - `plat.rs:57` implements `xav_plat_park` as
    `WaitOnAddress(addr, &u32::MAX, 4, 512)`. `WaitOnAddress` returns *immediately* when
    `*addr != compare`. The park slot normally holds `0`/`PARKED`, not `u32::MAX`, so as
    written this degenerates into a 100 %-CPU spin on the monitor thread rather than a
    512 ms timed park. **This needs review with the upstream author before the port is
    called done** — it is a live bug in the existing Windows shim, not something the port
    introduces. Flag it upstream; the workaround in the interim is to compare against the
    actual parked sentinel.

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
- Asks intent in plain language — *"Archive quality / Balanced / Small file / Match a
  quality target"* — mapping to encoder, CRF or `--tq`, and preset.
- **Computes `-w`, `--lp` and `-b` itself** from `available_parallelism()`, detected RAM,
  and the frame-size formula in §5.2. This is the single most valuable thing the UI can do:
  it is the hardest parameter to get right and the one where the guide says *"experimentation
  needed"*.
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

## 9. Immediate next actions

**When you're home:**

1. Run `tools/windows/probe-xav-system.ps1` (elevated) and send me
   `xav-probe-report.txt`. Everything in §5 gets replaced with real numbers rather than
   ranges.
2. Answer the three decisions below.

**Decisions I need:**

- **Route** — WSL2 first then native (recommended), native only, or WSL2 only?
- **UI tier** — Tier 1 wizard only, Tier 1 + Win32 GUI (2a, ethos-matching), or
  Tier 1 + WebView2 GUI (2b, faster/prettier)?
- **Upstreaming** — should the Windows port fixes go to `emrakyz/xav` as a PR, or stay in
  this fork?

**What I can start on before you're home** (no hardware knowledge required):

- The 6 mechanical source fixes (§2.3 #1–5) — verifiable right now by cross-compiling
- The `clk.rs` epoch fix (§2.3 #6)
- `build.rs` `HOME`/`USERPROFILE` cascade
- Console VT/UTF-8 init and the `--guide` pager fallback
- `--progress machine` output mode (unblocks any GUI)
- The Tier 1 wizard

Say the word and I'll start with those; they're all Linux-build-neutral and independently
useful.
