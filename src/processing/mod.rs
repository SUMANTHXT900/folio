//! Processing operations.
//!
//! Each operation lives in its own module and implements
//! [`Operation`](crate::core::operation::Operation) independently.
//! Shared infrastructure (jobs, timing, progress, errors) is never
//! duplicated inside operation modules.

pub mod pdf;
