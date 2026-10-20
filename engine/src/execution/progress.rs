//! Centralized progress events with room for hierarchical progress.
//!
//! Progress is never a bare integer: every event carries phase, completed,
//! total, message, timestamp, and job id. Future multi-worker aggregation
//! maps child ranges into parent ranges via [`SubProgressMapper`].

use std::time::SystemTime;

use crate::execution::job::JobId;

/// A structured progress event emitted during execution.
#[derive(Debug, Clone)]
pub struct ProgressEvent {
    job_id: JobId,
    phase: Option<String>,
    completed: u64,
    total: u64,
    message: Option<String>,
    timestamp: SystemTime,
}

impl ProgressEvent {
    /// Creates a progress event. `total == 0` means indeterminate.
    pub fn new(
        job_id: JobId,
        phase: Option<impl Into<String>>,
        completed: u64,
        total: u64,
        message: Option<impl Into<String>>,
    ) -> Self {
        Self {
            job_id,
            phase: phase.map(Into::into),
            completed,
            total,
            message: message.map(Into::into),
            // Platform clock (JS-backed on WASM, where `SystemTime::now()` panics).
            timestamp: crate::core::clock::wall_now(),
        }
    }

    /// Returns the job this event belongs to.
    #[must_use]
    pub fn job_id(&self) -> &JobId {
        &self.job_id
    }

    /// Returns the phase label (e.g. `"processing"`).
    #[must_use]
    pub fn phase(&self) -> Option<&str> {
        self.phase.as_deref()
    }

    /// Returns completed work units.
    #[must_use]
    pub const fn completed(&self) -> u64 {
        self.completed
    }

    /// Returns total work units (0 = indeterminate).
    #[must_use]
    pub const fn total(&self) -> u64 {
        self.total
    }

    /// Returns the optional message.
    #[must_use]
    pub fn message(&self) -> Option<&str> {
        self.message.as_deref()
    }

    /// Returns the event timestamp.
    #[must_use]
    pub const fn timestamp(&self) -> SystemTime {
        self.timestamp
    }

    /// Returns percentage in `0.0..=100.0`, or `None` when indeterminate.
    #[must_use]
    pub fn percentage(&self) -> Option<f64> {
        if self.total == 0 {
            return None;
        }
        let pct = (self.completed as f64 / self.total as f64) * 100.0;
        Some(pct.clamp(0.0, 100.0))
    }
}

/// Destination for progress events.
///
/// Implementations must be cheap and non-blocking; aggregation of
/// hierarchical (job -> worker) progress happens above this trait.
pub trait ProgressSink: Send + Sync {
    /// Receives one progress event.
    fn emit(&self, event: ProgressEvent);
}

/// Sink that drops all events. Default for library use.
#[derive(Debug, Default)]
pub struct NoopProgressSink;

impl ProgressSink for NoopProgressSink {
    fn emit(&self, _event: ProgressEvent) {}
}

/// Maps a child's `0..=child_total` range into a parent sub-range.
///
/// Future schedulers use one mapper per worker to aggregate hierarchical
/// progress without workers knowing about each other.
///
/// ```text
/// Job 0–100%
/// └── Worker mapped 20–90% via SubProgressMapper { parent_start: 20, parent_end: 90 }
/// ```
///
/// Range ends are parent percentages in `0.0..=100.0`. They are validated
/// on [`SubProgressMapper::map`]: `NaN` ends saturate to `0.0`, infinite or
/// out-of-range ends clamp to `0.0..=100.0`, inverted ranges (`start > end`)
/// are ordered (swapped) so mapping stays monotonic, and the mapped output
/// itself clamps to `0.0..=100.0` — mapping can never yield `NaN` or escape
/// the parent percentage domain.
#[derive(Debug, Clone, Copy)]
pub struct SubProgressMapper {
    parent_start: f64,
    parent_end: f64,
}

impl SubProgressMapper {
    /// Creates a mapper for the parent percentage sub-range.
    #[must_use]
    pub const fn new(parent_start: f64, parent_end: f64) -> Self {
        Self {
            parent_start,
            parent_end,
        }
    }

    /// Sanitizes one range end: `NaN` saturates to `0.0`, anything else
    /// clamps to the parent percentage domain `0.0..=100.0`.
    fn sanitize_end(value: f64) -> f64 {
        if value.is_nan() {
            0.0
        } else {
            value.clamp(0.0, 100.0)
        }
    }

    /// Returns the validated `(start, end)` pair with `start <= end`.
    fn ordered_range(&self) -> (f64, f64) {
        let (mut start, mut end) = (
            Self::sanitize_end(self.parent_start),
            Self::sanitize_end(self.parent_end),
        );
        if start > end {
            std::mem::swap(&mut start, &mut end);
        }
        (start, end)
    }

    /// Maps child progress to a parent percentage in `0.0..=100.0`.
    ///
    /// Indeterminate child progress (`total == 0`) reports the validated
    /// range start; degenerate ranges (equal ends after validation) report
    /// that single point for any input.
    #[must_use]
    pub fn map(&self, completed: u64, total: u64) -> f64 {
        let (start, end) = self.ordered_range();
        if total == 0 {
            return start;
        }
        let ratio = (completed as f64 / total as f64).clamp(0.0, 1.0);
        (start + ratio * (end - start)).clamp(0.0, 100.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct VecSink {
        events: Mutex<Vec<ProgressEvent>>,
    }

    impl ProgressSink for VecSink {
        fn emit(&self, event: ProgressEvent) {
            self.events.lock().expect("test lock").push(event);
        }
    }

    #[test]
    fn percentage_is_computed_and_clamped() {
        let event = ProgressEvent::new(JobId::new(), Some("processing"), 25, 100, None::<&str>);
        assert_eq!(event.percentage(), Some(25.0));

        let over = ProgressEvent::new(JobId::new(), None::<&str>, 200, 100, None::<&str>);
        assert_eq!(over.percentage(), Some(100.0));

        let indeterminate = ProgressEvent::new(JobId::new(), None::<&str>, 0, 0, None::<&str>);
        assert_eq!(indeterminate.percentage(), None);
    }

    #[test]
    fn events_preserve_emission_order() {
        let sink = VecSink {
            events: Mutex::new(Vec::new()),
        };
        let job = JobId::new();
        for i in 0..5 {
            sink.emit(ProgressEvent::new(
                job.clone(),
                None::<&str>,
                i,
                5,
                None::<&str>,
            ));
        }
        let events = sink.events.lock().expect("test lock");
        assert_eq!(events.len(), 5);
        for (i, event) in events.iter().enumerate() {
            assert_eq!(event.completed(), i as u64);
        }
    }

    #[test]
    fn sub_progress_mapper_aggregates_child_ranges() {
        let mapper = SubProgressMapper::new(20.0, 90.0);
        assert!((mapper.map(0, 10) - 20.0).abs() < f64::EPSILON);
        assert!((mapper.map(5, 10) - 55.0).abs() < f64::EPSILON);
        assert!((mapper.map(10, 10) - 90.0).abs() < f64::EPSILON);
    }

    #[test]
    fn mapper_saturates_nan_ends_to_finite_bounded_output() {
        for mapper in [
            SubProgressMapper::new(f64::NAN, 90.0),
            SubProgressMapper::new(20.0, f64::NAN),
            SubProgressMapper::new(f64::NAN, f64::NAN),
        ] {
            for (completed, total) in [(0, 10), (5, 10), (10, 10), (0, 0)] {
                let value = mapper.map(completed, total);
                assert!(
                    value.is_finite(),
                    "NaN range end must saturate to finite output, got {value}"
                );
                assert!(
                    (0.0..=100.0).contains(&value),
                    "mapped output {value} escapes 0..=100"
                );
            }
        }
    }

    #[test]
    fn mapper_orders_inverted_ranges_monotonically() {
        let mapper = SubProgressMapper::new(90.0, 20.0);
        let (lo, mid, hi) = (mapper.map(0, 10), mapper.map(5, 10), mapper.map(10, 10));
        assert!(
            lo <= mid && mid <= hi,
            "inverted range must map monotonically, got {lo}, {mid}, {hi}"
        );
        assert!(
            (lo - 20.0).abs() < 1e-9,
            "inverted start saturates, got {lo}"
        );
        assert!(
            (mid - 55.0).abs() < 1e-9,
            "inverted middle saturates, got {mid}"
        );
        assert!((hi - 90.0).abs() < 1e-9, "inverted end saturates, got {hi}");
    }

    #[test]
    fn mapper_clamps_out_of_range_ends_and_output() {
        let clamped = SubProgressMapper::new(-50.0, 500.0);
        assert!(
            (clamped.map(5, 10) - 50.0).abs() < 1e-9,
            "ends must clamp to 0..=100, got {}",
            clamped.map(5, 10)
        );
        let infinite = SubProgressMapper::new(f64::NEG_INFINITY, f64::INFINITY);
        assert!(
            (infinite.map(5, 10) - 50.0).abs() < 1e-9,
            "infinite ends must saturate, got {}",
            infinite.map(5, 10)
        );
        let normal = SubProgressMapper::new(20.0, 90.0);
        assert_eq!(
            normal.map(u64::MAX, 10),
            90.0,
            "overflowing child progress must saturate at the range end"
        );
    }
}
