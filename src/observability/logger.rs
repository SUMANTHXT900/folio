//! Replaceable event sinks: consoles, benchmarks, diagnostics, TS layer.

use std::sync::Mutex;

use crate::observability::event::EngineEvent;

/// Destination for structured [`EngineEvent`]s. Must be thread-safe.
pub trait EventSink: Send + Sync {
    /// Receives one event.
    fn record(&self, event: EngineEvent);
}

/// Sink that drops all events.
#[derive(Debug, Default)]
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn record(&self, _event: EngineEvent) {}
}

/// In-memory sink for tests and benchmark collectors.
#[derive(Debug, Default)]
pub struct VecEventSink {
    events: Mutex<Vec<EngineEvent>>,
}

impl VecEventSink {
    /// Creates an empty sink.
    #[must_use]
    pub fn new() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
        }
    }

    /// Returns a snapshot of recorded events.
    #[must_use]
    pub fn snapshot(&self) -> Vec<EngineEvent> {
        self.events.lock().expect("test lock").clone()
    }
}

impl EventSink for VecEventSink {
    fn record(&self, event: EngineEvent) {
        self.events.lock().expect("event sink lock").push(event);
    }
}

/// Sink that forwards each event to a closure.
pub struct FnEventSink<F>
where
    F: Fn(EngineEvent) + Send + Sync,
{
    callback: F,
}

impl<F> FnEventSink<F>
where
    F: Fn(EngineEvent) + Send + Sync,
{
    /// Creates a sink invoking `callback` per event.
    pub fn new(callback: F) -> Self {
        Self { callback }
    }
}

impl<F> EventSink for FnEventSink<F>
where
    F: Fn(EngineEvent) + Send + Sync,
{
    fn record(&self, event: EngineEvent) {
        (self.callback)(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::event::LogLevel;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn vec_sink_collects_events() {
        let sink = VecEventSink::new();
        sink.record(EngineEvent::new(LogLevel::Info, "a"));
        sink.record(EngineEvent::new(LogLevel::Error, "b"));
        assert_eq!(sink.snapshot().len(), 2);
    }

    #[test]
    fn fn_sink_forwards_events() {
        let count = Arc::new(AtomicUsize::new(0));
        let moved = count.clone();
        let sink = FnEventSink::new(move |_| {
            moved.fetch_add(1, Ordering::SeqCst);
        });
        sink.record(EngineEvent::new(LogLevel::Info, "a"));
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
