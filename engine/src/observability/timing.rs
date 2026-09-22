//! Timing primitives: wall clock for timestamps, monotonic clock for durations.
//!
//! The monotonic [`Timer`] wraps `std::time::Instant` on native targets.
//! `Instant::now()` panics on `wasm32-unknown-unknown`, so on WASM the
//! timer instead samples JS `performance.now()` (monotonic by spec) and
//! computes `Duration`s from millisecond deltas. Public API and native
//! behavior are unchanged; only the clock source differs per platform.

#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
use std::time::{Duration, SystemTime};

/// Returns the current wall-clock time (for `started_at`/`completed_at`).
///
/// Delegates to [`crate::core::clock::wall_now`], the single platform swap
/// point (JS `Date.now()` on WASM, where `SystemTime::now()` panics).
#[must_use]
pub fn wall_now() -> SystemTime {
    crate::core::clock::wall_now()
}

/// Monotonic timer for duration measurement.
///
/// Created at execution start; [`Timer::elapsed`] / [`Timer::stop`] read
/// the monotonic clock, immune to wall-clock adjustments.
#[derive(Debug)]
pub struct Timer {
    #[cfg(not(target_arch = "wasm32"))]
    start: Instant,
    /// `performance.now()` sample (ms) taken at construction.
    #[cfg(target_arch = "wasm32")]
    start_ms: f64,
}

impl Timer {
    /// Starts a timer on the monotonic clock.
    #[must_use]
    pub fn start() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            start: Instant::now(),
            #[cfg(target_arch = "wasm32")]
            start_ms: js_performance_now_ms(),
        }
    }

    /// Returns time elapsed since start (monotonic).
    #[must_use]
    pub fn elapsed(&self) -> Duration {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start.elapsed()
        }
        #[cfg(target_arch = "wasm32")]
        {
            let delta_ms = (js_performance_now_ms() - self.start_ms).max(0.0);
            Duration::from_micros((delta_ms * 1000.0) as u64)
        }
    }

    /// Stops the timer, returning the monotonic duration.
    #[must_use]
    pub fn stop(self) -> Duration {
        self.elapsed()
    }
}

/// JS `performance.now()`: monotonic milliseconds as `f64`.
///
/// Read via `Reflect` so the same code runs on `window` and inside Web
/// Workers (both expose a global `performance`). Only compiled for WASM;
/// the `js-sys` dependency itself is target-gated in `Cargo.toml`, so
/// native builds see zero new dependencies.
#[cfg(target_arch = "wasm32")]
fn js_performance_now_ms() -> f64 {
    use js_sys::{global, Function, Reflect};
    let performance =
        Reflect::get(&global(), &"performance".into()).expect("global performance object exists");
    let now = Reflect::get(&performance, &"now".into()).expect("performance.now exists");
    let now_fn: Function = now.into();
    now_fn
        .call0(&performance)
        .expect("performance.now() runs")
        .as_f64()
        .expect("performance.now() returns a number")
}

impl Default for Timer {
    fn default() -> Self {
        Self::start()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timer_measures_non_negative_duration() {
        let timer = Timer::start();
        let elapsed = timer.elapsed();
        assert!(elapsed < Duration::from_secs(60));
        let stopped = timer.stop();
        assert!(stopped >= Duration::ZERO);
    }
}
