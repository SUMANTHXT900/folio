//! Observability: wall-clock vs. monotonic timing, structured events, sinks.
//!
//! Wall-clock timestamps answer "when"; monotonic durations answer
//! "how long". Never compute durations by subtracting wall-clock times.

pub mod event;
pub mod logger;
pub mod timing;

pub use event::{EngineEvent, LogLevel};
pub use logger::{EventSink, FnEventSink, NoopEventSink, VecEventSink};
pub use timing::{wall_now, Timer};
