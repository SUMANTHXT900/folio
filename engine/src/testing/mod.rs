//! Dummy operations proving the execution lifecycle in tests.
//!
//! These are test harnesses, NOT features. They must never gain real
//! logic, storage access, or dependencies. Real PDF operations will live
//! under `processing::pdf::<operation>` and follow the same pattern.

pub mod pdf;

use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext, ParallelismHint};

/// Input for [`EchoOperation`]: an arbitrary payload string.
#[derive(Debug, Clone)]
pub struct EchoInput {
    /// Payload echoed back in the typed output.
    pub payload: String,
}

/// Options for [`EchoOperation`].
#[derive(Debug, Clone)]
pub struct EchoOptions {
    /// Number of progress steps to emit (simulates phased work).
    pub steps: u64,
}

impl Default for EchoOptions {
    fn default() -> Self {
        Self { steps: 4 }
    }
}

/// Trivial success-path harness: emits `steps` progress events, echoes input.
#[derive(Debug, Default)]
pub struct EchoOperation;

impl Operation for EchoOperation {
    type Input = EchoInput;
    type Options = EchoOptions;
    type Output = String;

    fn name(&self) -> &'static str {
        "test.echo"
    }

    fn capabilities(&self) -> OperationCapabilities {
        OperationCapabilities {
            parallelism: ParallelismHint::Sequential,
            supports_progress: true,
            supports_cancellation: true,
            supports_streaming: false,
        }
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: EchoInput,
        options: EchoOptions,
    ) -> Result<String, EngineError> {
        let total = options.steps.max(1);
        let phases = ["loading", "analysing", "processing", "writing output"];
        for step in 1..=total {
            ctx.check_cancellation()?;
            let phase = phases
                .get(((step - 1) as usize).min(phases.len() - 1))
                .copied();
            ctx.report_progress(phase, step, total, Some(&format!("step {step} of {total}")));
        }
        Ok(input.payload)
    }
}

/// Trivial failure-path harness: always returns a structured error.
#[derive(Debug, Default)]
pub struct FailingOperation;

impl Operation for FailingOperation {
    type Input = ();
    type Options = ();
    type Output = ();

    fn name(&self) -> &'static str {
        "test.failing"
    }

    fn capabilities(&self) -> OperationCapabilities {
        OperationCapabilities::sequential_lightweight()
    }

    fn execute<C: OperationContext>(
        &self,
        _ctx: &C,
        _input: (),
        _options: (),
    ) -> Result<(), EngineError> {
        Err(EngineError::new(
            ErrorCode::ProcessingFailed,
            "dummy operation failed as requested",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::job::JobId;

    struct NullCtx {
        id: JobId,
    }

    impl OperationContext for NullCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "test.ctx"
        }
        fn report_progress(
            &self,
            _phase: Option<&str>,
            _completed: u64,
            _total: u64,
            _message: Option<&str>,
        ) {
        }
        fn is_cancelled(&self) -> bool {
            false
        }
        fn check_cancellation(&self) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[test]
    fn echo_returns_payload() {
        let ctx = NullCtx { id: JobId::new() };
        let out = EchoOperation
            .execute(
                &ctx,
                EchoInput {
                    payload: "ping".into(),
                },
                EchoOptions::default(),
            )
            .expect("echo succeeds");
        assert_eq!(out, "ping");
    }

    #[test]
    fn failing_returns_structured_error() {
        let ctx = NullCtx { id: JobId::new() };
        let err = FailingOperation
            .execute(&ctx, (), ())
            .expect_err("must fail");
        assert_eq!(err.code(), ErrorCode::ProcessingFailed);
    }
}
