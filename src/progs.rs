use alloc::sync::Arc;
#[cfg(target_os = "linux")]
use alloc::vec::Vec;
use core::{
    fmt::{self, Write as _},
    iter::repeat_with,
    mem::MaybeUninit,
    str::from_utf8,
    sync::atomic::{
        AtomicBool, AtomicU32, AtomicU64, AtomicUsize,
        Ordering::{Relaxed, Release},
    },
    time::Duration as Durat,
};

use crate::{
    chunk::{Chunk, PRIOR_SECS},
    clk::Mono,
    encoder::{
        Encoder,
        Encoder::{Avm, SvtAv1, Vvenc, X264, X265},
    },
    error::eprint,
    ffms::VidInf,
    io::{Read, Write as _, print_fmt, stderr, stdout as io_stdout},
    sync::{Guard, Mutex},
    thread::{JoinHandle, park_state, sleep, spawn},
};

const BAR_WIDTH: usize = 20;
pub const INTERVAL_MS: u64 = 512;
const READ_CAP: usize = 8192;

static MACHINE: AtomicBool = AtomicBool::new(false);
static EMIT_LAST: AtomicU64 = AtomicU64::new(0);

pub fn set_machine() {
    MACHINE.store(true, Relaxed);
}

#[inline]
pub fn machine() -> bool {
    MACHINE.load(Relaxed)
}

/// Write one machine-readable progress record to stderr.
///
/// Machine mode replaces the ANSI TUI wholesale: consumers parse
/// line-delimited `XAVP1 key=value` records off stderr, and must never see
/// cursor movement, so every machine-mode emitter funnels through here.
/// Best-effort on purpose -- a closed stderr must not kill an encode.
fn emit(args: fmt::Arguments<'_>) {
    let mut e = stderr();
    _ = e.write_fmt(format_args!("XAVP1 {args}\n"));
    _ = e.flush();
}

/// [`emit`], rate-limited to one record per [`INTERVAL_MS`] globally.
///
/// Hot paths (per-packet copy updates, per-frame audio counts) call this;
/// terminal updates that must not be lost call [`emit`] directly.
fn emit_throttled(args: fmt::Arguments<'_>) {
    let now = Mono::now().raw();
    let last = EMIT_LAST.load(Relaxed);
    if now.wrapping_sub(last) < INTERVAL_MS * 1_000_000 {
        return;
    }
    if EMIT_LAST
        .compare_exchange(last, now, Relaxed, Relaxed)
        .is_ok()
    {
        emit(args);
    }
}

/// Chunk-completion event for machine consumers. No-op in TUI mode.
pub fn emit_chunk_done(idx: u16, frames: usize, bytes: u64, crf_score: Option<(f32, f32)>) {
    if !machine() {
        return;
    }
    if let Some((crf, score)) = crf_score {
        emit(format_args!(
            "event=chunk idx={idx} frames={frames} bytes={bytes} crf={crf:.2} score={score:.4}"
        ));
    } else {
        emit(format_args!(
            "event=chunk idx={idx} frames={frames} bytes={bytes}"
        ));
    }
}

use crate::util::{C, G, P, R, W, Y, assume_unreachable};

const B_HASH: &str = "\x1b[1;94m#";
const Y_DASH: &str = "\x1b[1;93m-";

const LINE_CAP: usize = 512;

#[derive(Clone)]
#[repr(C)]
struct Line {
    buf: [u8; LINE_CAP],
    len: usize,
}

impl Line {
    const fn new() -> Self {
        Self {
            buf: [0; LINE_CAP],
            len: 0,
        }
    }
}

impl fmt::Write for Line {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let b = s.as_bytes();
        let n = b.len().min(LINE_CAP - self.len);
        unsafe {
            self.buf
                .get_unchecked_mut(self.len..self.len + n)
                .copy_from_slice(b.get_unchecked(..n));
        }
        self.len += n;
        Ok(())
    }
}

const TAG_EMPTY: u32 = 0;
const TAG_LIB: u32 = 1;
#[cfg(feature = "vship")]
const TAG_MET: u32 = 2;
const TAG_TXT: u32 = 3;

#[repr(C, align(64))]
struct Slot {
    tag: AtomicU32,
    cnt: u32,
    enced: AtomicUsize,
    flu: AtomicUsize,
    tot: usize,
    idx: usize,
    fl: usize,
    start: u64,
    c: f32,
    s: f32,
    txt: Mutex<Line>,
}

impl Slot {
    const fn new() -> Self {
        Self {
            tag: AtomicU32::new(TAG_EMPTY),
            cnt: 0,
            enced: AtomicUsize::new(0),
            flu: AtomicUsize::new(0),
            tot: 0,
            idx: 0,
            fl: 0,
            start: 0,
            c: 0.0,
            s: 0.0,
            txt: Mutex::new(Line::new()),
        }
    }
}

fn write_tag(w: &mut impl fmt::Write, idx: u16, cs: Option<(f32, Option<f32>)>) {
    match cs {
        Some((c, Some(s))) => _ = write!(w, "{C}[{idx:04} / F {c:5.2} / {s:5.2}{C}]"),
        Some((c, None)) => _ = write!(w, "{C}[{idx:04} / F {c:5.2} / {:5}{C}]", ""),
        None => _ = write!(w, "{C}[{idx:04}{C}]"),
    }
}

fn write_bar(w: &mut impl fmt::Write, filled: usize, hash: &str, dash: &str) {
    for _ in 0..filled {
        _ = w.write_str(hash);
    }
    for _ in filled..BAR_WIDTH {
        _ = w.write_str(dash);
    }
}

unsafe extern "C" {
    fn xav_pb_init(p: *mut ProgsBar);
    fn xav_pb_copy(p: *mut ProgsBar, cur: usize, tot: usize);
    fn xav_pb_au(p: *mut ProgsBar, cur: usize, tot: usize, ln: usize, ps: usize, ti: usize);
    fn xav_pb_mon(dn: *const u8, st: *const u8, pk: *const u8, tot: usize, ln: usize, pi: usize);
    fn xav_pb_frames(p: *mut ProgsBar, cur: usize, tot: usize, ln: usize, lb: *const u8, ll: usize);
    fn xav_pb_fin(sl: *mut u8, prc: *mut u8);
    fn xav_pb_draw(dw: *const Draw);
}

#[repr(C)]
pub struct ProgsBar {
    start_ns: u64,
    last_ns: u64,
    tsc_next: u64,
    tsc_last: u64,
    tsc_ival: u64,
    cnt: i32,
    stride: i32,
    checks: u32,
}

impl ProgsBar {
    pub fn new() -> Self {
        let mut s = MaybeUninit::<Self>::uninit();
        unsafe {
            xav_pb_init(s.as_mut_ptr());
            s.assume_init()
        }
    }

    pub fn up_frames(&mut self, current: usize, tot: usize, line: usize, label: &str) {
        if machine() {
            if current >= tot {
                emit(format_args!("phase={label} cur={current} tot={tot}"));
            } else {
                emit_throttled(format_args!("phase={label} cur={current} tot={tot}"));
            }
            return;
        }
        unsafe {
            xav_pb_frames(
                &raw mut *self,
                current,
                tot,
                line,
                label.as_ptr(),
                label.len(),
            );
        }
    }

    pub fn up_au(&mut self, current: usize, tot: usize, line: usize, pass: u8, track_id: u8) {
        if machine() {
            if current >= tot {
                emit(format_args!(
                    "phase=audio track={track_id} pass={pass} cur={current} tot={tot}"
                ));
            } else {
                emit_throttled(format_args!(
                    "phase=audio track={track_id} pass={pass} cur={current} tot={tot}"
                ));
            }
            return;
        }
        unsafe {
            xav_pb_au(
                &raw mut *self,
                current,
                tot,
                line,
                pass as usize,
                track_id as usize,
            );
        }
    }

    pub fn up_copy(&mut self, current: usize, tot: usize) {
        if machine() {
            if current >= tot {
                emit(format_args!("phase=copy cur={current} tot={tot}"));
            } else {
                emit_throttled(format_args!("phase=copy cur={current} tot={tot}"));
            }
            return;
        }
        unsafe { xav_pb_copy(&raw mut *self, current, tot) }
    }
}

pub fn monitor_au(
    done: &AtomicUsize,
    stop: &AtomicBool,
    tot: usize,
    line: usize,
    pass: u8,
    tid: u8,
) {
    if machine() {
        // The asm monitor exists to redraw a bar; in machine mode a plain
        // polling loop over the same counters is all that is needed.
        while !stop.load(Relaxed) {
            emit_throttled(format_args!(
                "phase=audio track={tid} pass={pass} cur={} tot={tot}",
                done.load(Relaxed)
            ));
            sleep(Durat::from_millis(INTERVAL_MS));
        }
        emit(format_args!(
            "phase=audio track={tid} pass={pass} cur={} tot={tot}",
            done.load(Relaxed)
        ));
        return;
    }
    unsafe {
        xav_pb_mon(
            (&raw const *done).cast(),
            (&raw const *stop).cast(),
            park_state(),
            tot,
            line,
            usize::from(pass) | (usize::from(tid) << 8),
        );
    }
}

fn guard(m: &Mutex<Line>) -> Guard<'_, Line> {
    m.lock()
}

struct Shared {
    boards: Vec<Slot>,
    processed: AtomicUsize,
    stop: AtomicBool,
    start: Mono,
    tot_chnks: usize,
    tot_frames: usize,
    fps_num: u32,
    fps_den: u32,
    completed: Arc<AtomicUsize>,
    completed_frames: Arc<AtomicUsize>,
    tot_sz: Arc<AtomicU64>,
    init_frames: usize,
}

impl Shared {
    fn put(&self, id: usize, line: Line) {
        if let Some(s) = self.boards.get(id) {
            *guard(&s.txt) = line;
            s.tag.store(TAG_TXT, Release);
        }
    }

    fn board(&self, id: usize) -> *mut Slot {
        unsafe { (&raw const *self.boards.get_unchecked(id)).cast_mut() }
    }

    fn clear(&self, id: usize) {
        if let Some(s) = self.boards.get(id) {
            s.tag.store(TAG_EMPTY, Release);
        }
    }
}

#[derive(Clone, Copy)]
pub struct Watch {
    pub worker_id: usize,
    pub chnk_idx: u16,
    pub frames: usize,
    pub track_frames: bool,
    pub crf_score: Option<(f32, Option<f32>)>,
}

pub struct ProgsTrack {
    inner: Arc<Shared>,
}

impl Drop for ProgsTrack {
    fn drop(&mut self) {
        self.inner.stop.store(true, Relaxed);
    }
}

impl ProgsTrack {
    pub fn new(
        chnks: &[Chunk],
        inf: &VidInf,
        worker_cnt: usize,
        init_frames: usize,
        completed: Arc<AtomicUsize>,
        completed_frames: Arc<AtomicUsize>,
        tot_sz: Arc<AtomicU64>,
    ) -> (Self, JoinHandle<()>) {
        if !machine() {
            print!("\x1b[s");
            _ = io_stdout().flush();
        }

        let tot_frames = chnks.iter().map(|c| c.end - c.start).sum();

        let inner = Arc::new(Shared {
            boards: repeat_with(Slot::new).take(worker_cnt).collect(),
            processed: AtomicUsize::new(0),
            stop: AtomicBool::new(false),
            start: Mono::now(),
            tot_chnks: chnks.len(),
            tot_frames,
            fps_num: inf.fps_num,
            fps_den: inf.fps_den,
            completed,
            completed_frames,
            tot_sz,
            init_frames,
        });

        let disp = Arc::clone(&inner);
        let handle = if machine() {
            spawn(move || machine_loop(&disp))
        } else {
            spawn(move || display_loop(&disp))
        };

        (Self { inner }, handle)
    }

    pub fn watch_enc<R: Read + Send + 'static>(&self, stderr: R, w: Watch, encoder: Encoder) {
        let inner = Arc::clone(&self.inner);

        spawn(move || match encoder {
            SvtAv1 => assume_unreachable(),
            Avm => watch_avm(&inner, stderr, w),
            X265 | X264 => watch_x265(&inner, stderr, w),
            Vvenc => watch_vvenc(&inner, stderr, w),
        });
    }
}

#[repr(C)]
struct Draw {
    boards: *const u8,
    nb: usize,
    buf: *mut u8,
    cmp: *const u8,
    cfr: *const u8,
    tsz: *const u8,
    prc: *const u8,
    pri: *const u8,
    start_ns: u64,
    tot_chnks: usize,
    tot_frames: usize,
    init_frames: usize,
    fps_num: u32,
    fps_den: u32,
}

pub struct Tracker {
    slot: *mut Slot,
    prc: *mut u8,
}

impl Tracker {
    fn mk(
        prog: &ProgsTrack,
        worker_id: usize,
        chnk_idx: u16,
        tot: usize,
        track_frames: bool,
        crf_score: Option<(f32, Option<f32>)>,
        tag: u32,
    ) -> Self {
        let (c, s, fl) = match crf_score {
            Some((c, Some(s))) => (c, s, 3),
            Some((c, None)) => (c, 0.0, 1),
            None => (0.0, 0.0, 0),
        };
        let slot = prog.inner.board(worker_id);
        unsafe {
            (*slot).cnt = u32::from(track_frames);
            (*slot).enced.store(0, Relaxed);
            (*slot).flu.store(0, Relaxed);
            (*slot).tot = tot;
            (*slot).idx = usize::from(chnk_idx);
            (*slot).fl = fl;
            (*slot).start = Mono::now().raw();
            (*slot).c = c;
            (*slot).s = s;
            (*slot).tag.store(tag, Release);
        }
        Self {
            slot,
            prc: (&raw const prog.inner.processed).cast_mut().cast(),
        }
    }

    pub fn new(
        prog: &ProgsTrack,
        worker_id: usize,
        chnk_idx: u16,
        tot: usize,
        track_frames: bool,
        crf_score: Option<(f32, Option<f32>)>,
    ) -> Self {
        Self::mk(
            prog,
            worker_id,
            chnk_idx,
            tot,
            track_frames,
            crf_score,
            TAG_LIB,
        )
    }

    #[cfg(feature = "vship")]
    pub fn new_met(
        prog: &ProgsTrack,
        worker_id: usize,
        chnk_idx: u16,
        tot: usize,
        crf_score: Option<(f32, Option<f32>)>,
    ) -> Self {
        Self::mk(prog, worker_id, chnk_idx, tot, false, crf_score, TAG_MET)
    }

    #[inline]
    pub fn set(&self, n: usize) {
        unsafe { (*self.slot).enced.store(n, Relaxed) }
    }

    pub fn finish(&self) {
        unsafe { xav_pb_fin(self.slot.cast(), self.prc) }
    }
}

fn watch_avm(inner: &Shared, rd: impl Read, w: Watch) {
    let Watch {
        worker_id,
        chnk_idx,
        frames,
        track_frames,
        crf_score,
    } = w;
    let started = Mono::now();
    let mut lr = LineReader::new(rd, b'\n');
    let mut poc_cnt = 0;
    let mut last_poc = 0;
    let mut last_update = Mono::now();

    loop {
        if !lr.fill() {
            break;
        }

        while let Some(rec) = lr.next_buffered() {
            let Ok(raw) = from_utf8(rec) else {
                continue;
            };
            let text = raw.trim();
            if text.contains("error") || text.contains("Error") {
                eprint(format_args!("{text}"));
            }
            if text.starts_with("POC") {
                poc_cnt += 1;
            }
        }

        if last_update.elapsed() >= Durat::from_millis(INTERVAL_MS) {
            last_update = Mono::now();

            let tot = frames.max(poc_cnt);
            let fps = poc_cnt as f32 / started.elapsed().as_secs_f32().max(0.001);
            let filled = (BAR_WIDTH * poc_cnt / tot.max(1)).min(BAR_WIDTH);
            let perc = (poc_cnt * 100 / tot.max(1)).min(100);

            let mut line = Line::new();
            write_tag(&mut line, chnk_idx, crf_score);
            _ = write!(line, " {P}[");
            write_bar(&mut line, filled, B_HASH, Y_DASH);
            _ = write!(
                line,
                "{P}] {W}{perc:3}%{C}, {Y}{fps:6.2}{C}, {G}{poc_cnt:3}{C}/{R}{tot:3}"
            );

            if track_frames {
                let d = poc_cnt.saturating_sub(last_poc);
                last_poc = poc_cnt;
                inner.processed.fetch_add(d, Relaxed);
            }
            inner.put(worker_id, line);
        }
    }

    inner.clear(worker_id);
}

struct LineReader<R: Read> {
    rd: R,
    acc: [u8; READ_CAP],
    len: usize,
    start: usize,
    delim: u8,
}

impl<R: Read> LineReader<R> {
    const fn new(rd: R, delim: u8) -> Self {
        Self {
            rd,
            acc: [0; READ_CAP],
            len: 0,
            start: 0,
            delim,
        }
    }

    fn fill(&mut self) -> bool {
        match self.rd.read(&mut self.acc[self.len..]) {
            Ok(0) | Err(_) => false,
            Ok(n) => {
                self.len += n;
                true
            }
        }
    }

    fn next_buffered(&mut self) -> Option<&[u8]> {
        let buf = &self.acc[self.start..self.len];
        if let Some(rel) = buf.iter().position(|&b| b == self.delim) {
            let s = self.start;
            self.start = s + rel + 1;
            return Some(&self.acc[s..s + rel]);
        }
        self.acc.copy_within(self.start..self.len, 0);
        self.len -= self.start;
        self.start = 0;
        if self.len == READ_CAP {
            self.len = 0;
        }
        None
    }
}

fn watch_vvenc(inner: &Shared, rd: impl Read, w: Watch) {
    let Watch {
        worker_id,
        chnk_idx,
        frames,
        track_frames,
        crf_score,
    } = w;
    let started = Mono::now();
    let mut lr = LineReader::new(rd, b'\n');
    let mut poc_cnt = 0;
    let mut last_poc = 0;
    let mut last_update = Mono::now();

    loop {
        if !lr.fill() {
            break;
        }

        while let Some(rec) = lr.next_buffered() {
            let Ok(raw) = from_utf8(rec) else {
                continue;
            };
            let text = raw.trim();
            if text.contains("error") || text.contains("Error") {
                eprint(format_args!("{text}"));
            }
            if text.starts_with("POC") {
                poc_cnt += 1;
            }
        }

        if last_update.elapsed() >= Durat::from_millis(INTERVAL_MS) {
            last_update = Mono::now();

            let tot = frames.max(poc_cnt);
            let fps = poc_cnt as f32 / started.elapsed().as_secs_f32().max(0.001);
            let filled = (BAR_WIDTH * poc_cnt / tot.max(1)).min(BAR_WIDTH);
            let perc = (poc_cnt * 100 / tot.max(1)).min(100);

            let mut line = Line::new();
            write_tag(&mut line, chnk_idx, crf_score);
            _ = write!(line, " {P}[");
            write_bar(&mut line, filled, B_HASH, Y_DASH);
            _ = write!(
                line,
                "{P}] {W}{perc:3}%{C}, {Y}{fps:6.2}{C}, {G}{poc_cnt:3}{C}/{R}{tot:3}"
            );

            if track_frames {
                let d = poc_cnt.saturating_sub(last_poc);
                last_poc = poc_cnt;
                inner.processed.fetch_add(d, Relaxed);
            }
            inner.put(worker_id, line);
        }
    }

    inner.clear(worker_id);
}

fn watch_x265(inner: &Shared, rd: impl Read, w: Watch) {
    let Watch {
        worker_id,
        chnk_idx,
        frames,
        track_frames,
        crf_score,
    } = w;
    let mut lr = LineReader::new(rd, b'\r');
    let mut last_frames = 0;
    let mut last_update = Mono::now();

    loop {
        if !lr.fill() {
            break;
        }

        while let Some(rec) = lr.next_buffered() {
            let Ok(raw) = from_utf8(rec) else {
                continue;
            };
            let text = raw.trim();

            if text.is_empty() {
                continue;
            }

            if !text.starts_with('[') {
                if !text.starts_with("encoded") {
                    eprint(format_args!("{text}"));
                }
                continue;
            }

            if last_update.elapsed() < Durat::from_millis(INTERVAL_MS) {
                continue;
            }
            last_update = Mono::now();

            let Some((cur, fps, kbps)) = parse_x265(text) else {
                continue;
            };

            let filled = (BAR_WIDTH * cur / frames.max(1)).min(BAR_WIDTH);
            let perc = cur * 100 / frames.max(1);

            let mut line = Line::new();
            write_tag(&mut line, chnk_idx, crf_score);
            _ = write!(line, " {P}[");
            write_bar(&mut line, filled, B_HASH, Y_DASH);
            _ = write!(
                line,
                "{P}] {W}{perc:3}% {Y}{cur:3}/{frames:3} {G}{fps:6.2} {W}| {P}{kbps:.0} kb/s"
            );

            if track_frames {
                let d = cur.saturating_sub(last_frames);
                last_frames = cur;
                inner.processed.fetch_add(d, Relaxed);
            }
            inner.put(worker_id, line);
        }
    }

    inner.clear(worker_id);
}

fn parse_x265(s: &str) -> Option<(usize, f32, f32)> {
    let rest = s.split(']').nth(1)?;
    let mut parts = rest.split(',');

    let cur = parts
        .next()?
        .trim()
        .split('/')
        .next()?
        .trim()
        .parse()
        .ok()?;
    let fps = parts.next()?.split_whitespace().next()?.parse().ok()?;
    let kbps = parts.next()?.split_whitespace().next()?.parse().ok()?;

    Some((cur, fps, kbps))
}

/// One `phase=enc` snapshot from the same counters the TUI draws from.
fn machine_snap(s: &Shared) {
    let frames = s.completed_frames.load(Relaxed);
    let secs = s.start.elapsed().as_secs_f64();
    let fps = if secs > 0.0 { frames as f64 / secs } else { 0.0 };
    let tot_done = s.init_frames + frames;
    let left = s.tot_frames.saturating_sub(tot_done);
    let eta = if fps > 0.0 { (left as f64 / fps) as u64 } else { 0 };
    emit(format_args!(
        "phase=enc chunks={}/{} frames={tot_done}/{} fps={fps:.2} eta_s={eta} elapsed_s={} \
         out_bytes={}",
        s.completed.load(Relaxed),
        s.tot_chnks,
        s.tot_frames,
        PRIOR_SECS.load(Relaxed) + secs as u64,
        s.tot_sz.load(Relaxed),
    ));
}

/// Machine-mode replacement for [`display_loop`]: same cadence, same stop
/// protocol, but line records on stderr instead of the asm-drawn TUI.
fn machine_loop(s: &Shared) {
    loop {
        sleep(Durat::from_millis(INTERVAL_MS));
        if s.stop.load(Relaxed) {
            break;
        }
        machine_snap(s);
    }
    machine_snap(s);
}

fn display_loop(s: &Shared) {
    let nb = s.boards.len();
    let mut buf: Vec<u8> = Vec::with_capacity(nb * (LINE_CAP + 64) + 1024);
    let dw = Draw {
        boards: s.boards.as_ptr().cast(),
        nb,
        buf: buf.as_mut_ptr(),
        cmp: (&raw const *s.completed).cast(),
        cfr: (&raw const *s.completed_frames).cast(),
        tsz: (&raw const *s.tot_sz).cast(),
        prc: (&raw const s.processed).cast(),
        pri: (&raw const PRIOR_SECS).cast(),
        start_ns: s.start.raw(),
        tot_chnks: s.tot_chnks,
        tot_frames: s.tot_frames,
        init_frames: s.init_frames,
        fps_num: s.fps_num,
        fps_den: s.fps_den,
    };
    loop {
        sleep(Durat::from_millis(INTERVAL_MS));
        if s.stop.load(Relaxed) {
            break;
        }
        unsafe { xav_pb_draw(&raw const dw) }
    }
    unsafe { xav_pb_draw(&raw const dw) }
}
