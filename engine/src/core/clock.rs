//! Platform clock source for timestamps.
//!
//! Native targets use `std::time` directly. On `wasm32-unknown-unknown`
//! `std::time::{SystemTime, Instant}` PANIC at runtime ("time not
//! implemented on this platform" — verified in the toolchain's
//! `sys/pal/wasm → unsupported/time.rs`), so this module provides the
//! single swap point: wall-clock time backed by JS `Date.now()`.
//! Monotonic timing lives in [`crate::observability::timing::Timer`],
//! which uses `performance.now()` on WASM for the same reason.
//!
//! Semantics are unchanged on native targets (this delegates to
//! `SystemTime::now`); on WASM the values are real browser clocks, not
//! fabrications — only the source differs, never the meaning.

use std::time::SystemTime;
#[cfg(target_arch = "wasm32")]
use std::time::{Duration, UNIX_EPOCH};

/// Current wall-clock time (for `started_at`/`completed_at`/timestamps).
#[must_use]
pub fn wall_now() -> SystemTime {
    #[cfg(not(target_arch = "wasm32"))]
    {
        SystemTime::now()
    }
    #[cfg(target_arch = "wasm32")]
    {
        // `UNIX_EPOCH + duration` is pure `Duration` arithmetic: no
        // platform clock involved, so it works where `SystemTime::now()`
        // panics. `Date.now()` is whole milliseconds; micros keep full
        // precision without any panicking conversion.
        UNIX_EPOCH + Duration::from_micros((js_date_now_ms() * 1000.0) as u64)
    }
}

/// JS `Date.now()`: milliseconds since the Unix epoch as `f64`.
#[cfg(target_arch = "wasm32")]
fn js_date_now_ms() -> f64 {
    js_sys::Date::now()
}
