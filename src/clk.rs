use core::time::Duration;
#[cfg(not(target_os = "linux"))]
use std::{
    sync::OnceLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "linux")]
use crate::sys::{clock_mono_ns, clock_real};

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
pub struct Mono(u64);

/// Process-wide monotonic epoch for the non-Linux path.
///
/// `Mono::raw` hands a bare nanosecond stamp to the progress assembly, which
/// compares it against whatever `xav_plat_now` returns (see `plat.rs`). Both
/// sides must therefore measure from the *same* origin, so both read this.
/// On Linux the two agree for free because both read `CLOCK_MONOTONIC`.
#[cfg(not(target_os = "linux"))]
pub fn epoch() -> Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

#[cfg(not(target_os = "linux"))]
#[inline]
fn since_epoch_ns() -> u64 {
    epoch().elapsed().as_nanos() as u64
}

/// Nanoseconds since [`epoch`] — same representation as the Linux variant, so
/// `raw()` means the same thing on both paths.
#[cfg(not(target_os = "linux"))]
#[derive(Clone, Copy)]
pub struct Mono(u64);

#[cfg(target_os = "linux")]
impl Mono {
    #[inline]
    pub fn now() -> Self {
        Self(clock_mono_ns())
    }

    #[inline]
    pub fn elapsed(self) -> Duration {
        Duration::from_nanos(clock_mono_ns() - self.0)
    }

    #[inline]
    pub const fn raw(self) -> u64 {
        self.0
    }
}

#[cfg(not(target_os = "linux"))]
impl Mono {
    #[inline]
    pub fn now() -> Self {
        Self(since_epoch_ns())
    }

    #[inline]
    pub fn elapsed(self) -> Duration {
        Duration::from_nanos(since_epoch_ns().saturating_sub(self.0))
    }

    #[inline]
    pub const fn raw(self) -> u64 {
        self.0
    }
}

#[cfg(target_os = "linux")]
pub fn realtime() -> (u64, u32) {
    clock_real()
}

#[cfg(not(target_os = "linux"))]
pub fn realtime() -> (u64, u32) {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    (d.as_secs(), d.subsec_nanos())
}
