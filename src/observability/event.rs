//! Structured engine events (replaces ad-hoc `println!` logging).

use std::fmt;
use std::time::SystemTime;

use crate::execution::job::JobId;

/// Severity of a structured event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    /// Fine-grained diagnostic trace.
    Debug,
    /// Normal lifecycle information.
    Info,
    /// Potential problem that did not fail the job.
    Warn,
    /// Failure or cancellation.
    Error,
}

impl fmt::Display for LogLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Debug => f.write_str("DEBUG"),
            Self::Info => f.write_str("INFO"),
            Self::Warn => f.write_str("WARN"),
            Self::Error => f.write_str("ERROR"),
        }
    }
}

/// A structured event consumable by consoles, benchmarks, diagnostics,
/// or the future TypeScript layer.
#[derive(Debug, Clone)]
pub struct EngineEvent {
    timestamp: SystemTime,
    level: LogLevel,
    job_id: Option<JobId>,
    operation: Option<String>,
    phase: Option<String>,
    message: String,
}

impl EngineEvent {
    /// Creates an event stamped with the current wall-clock time.
    pub fn new(level: LogLevel, message: impl Into<String>) -> Self {
        Self {
            // Platform clock (JS-backed on WASM, where `SystemTime::now()` panics).
            timestamp: crate::core::clock::wall_now(),
            level,
            job_id: None,
            operation: None,
            phase: None,
            message: message.into(),
        }
    }

    /// Attaches the job id.
    #[must_use]
    pub fn with_job_id(mut self, job_id: JobId) -> Self {
        self.job_id = Some(job_id);
        self
    }

    /// Attaches the operation name.
    #[must_use]
    pub fn with_operation(mut self, operation: impl Into<String>) -> Self {
        self.operation = Some(operation.into());
        self
    }

    /// Attaches the phase label.
    #[must_use]
    pub fn with_phase(mut self, phase: impl Into<String>) -> Self {
        self.phase = Some(phase.into());
        self
    }

    /// Returns the event timestamp.
    #[must_use]
    pub const fn timestamp(&self) -> SystemTime {
        self.timestamp
    }

    /// Returns the severity.
    #[must_use]
    pub const fn level(&self) -> LogLevel {
        self.level
    }

    /// Returns the job id, if attached.
    #[must_use]
    pub fn job_id(&self) -> Option<&JobId> {
        self.job_id.as_ref()
    }

    /// Returns the operation name, if attached.
    #[must_use]
    pub fn operation(&self) -> Option<&str> {
        self.operation.as_deref()
    }

    /// Returns the phase label, if attached.
    #[must_use]
    pub fn phase(&self) -> Option<&str> {
        self.phase.as_deref()
    }

    /// Returns the message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_carries_structured_fields() {
        let job = JobId::new();
        let event = EngineEvent::new(LogLevel::Info, "started")
            .with_job_id(job.clone())
            .with_operation("pdf.inspect")
            .with_phase("loading");
        assert_eq!(event.level(), LogLevel::Info);
        assert_eq!(event.job_id(), Some(&job));
        assert_eq!(event.operation(), Some("pdf.inspect"));
        assert_eq!(event.phase(), Some("loading"));
        assert_eq!(event.message(), "started");
    }

    #[test]
    fn levels_order_correctly() {
        assert!(LogLevel::Debug < LogLevel::Info);
        assert!(LogLevel::Warn < LogLevel::Error);
    }
}
