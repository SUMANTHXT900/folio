//! `folio-engine`: local, offline document-processing core.
//!
//! Modular operation-oriented architecture (see `ARCHITECTURE.md`):
//! Lesson 0 built the execution foundation, Lesson 1 added the first
//! real operation (`pdf.inspect`). No UI, storage, networking, or WASM
//! bindings live here.

pub mod core;
pub mod execution;
pub mod observability;
pub mod processing;

/// Dummy operations used only to prove the execution lifecycle in tests.
///
/// These are test harnesses, not features, and must never gain real logic.
pub mod testing;
