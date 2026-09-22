//! `pdf.rotate`: rotate selected pages by a relative angle.
//!
//! Takes 1-based page numbers plus an integer degree angle and produces a
//! new [`PdfDocument`] where each selected page's effective rotation is
//! advanced by that angle. Relative semantics: a page showing `90°`
//! rotated by `+90°` shows `180°`; results normalize into
//! `0°/90°/180°/270°`, so `+90°` on `270°` yields `0°` and `-90°` on `0°`
//! yields `270°`.
//!
//! Only quarter turns are supported (`/Rotate` represents multiples of
//! 90°): any integer equivalent to a multiple of 90° is accepted
//! (`360` → `0`, `450` → `90`, `-90` → `270`); anything else is rejected.
//! The selection list only names pages — its order is irrelevant — and
//! duplicates are rejected. An empty selection or a `0°` angle is a valid
//! no-op producing an independent full copy (never the original object).
//!
//! Implementation: the source is deep-copied once via the shared Lesson 3
//! primitive (`core::copy`), then each selected page gets its final
//! effective `/Rotate` materialized directly on its own dictionary. The
//! copy flattens the page tree with a rotation-free root, so writing the
//! resolved value onto the page can never shift unselected pages — shared
//! ancestors are read, never mutated.
//!
//! Never mutates the input. No range-string parsing in the core, no
//! rendering, no compression, no encryption — those are later lessons.

use std::collections::HashSet;

use crate::core::document::{Document, DocumentData};
use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::copy::{copy_pages, find_invalid_page};
use crate::processing::pdf::core::document::normalize_quarter_turn;
use crate::processing::pdf::core::{load_pdf, PageNumber, PdfDocument};

/// Input for [`RotateOperation`]: owned PDF bytes plus an optional label.
///
/// Built from raw bytes or from a core [`Document`] with inline data.
/// Reference-handle documents are rejected: resolving storage handles is
/// an outer-layer concern, not a processing-core one.
#[derive(Debug, Clone)]
pub struct RotateInput {
    /// Raw PDF bytes. Owned so the operation signature stays `'static`;
    /// only borrowed (`&[u8]`) downstream — never copied again, never mutated.
    pub data: Vec<u8>,
    /// Optional human-readable label, carried through for diagnostics.
    pub name: Option<String>,
}

impl RotateInput {
    /// Creates input from raw PDF bytes.
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, EngineError> {
        if data.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "rotate input bytes must not be empty",
            ));
        }
        Ok(Self { data, name: None })
    }

    /// Creates input from a core [`Document`].
    pub fn from_document(document: &Document) -> Result<Self, EngineError> {
        match document.data() {
            DocumentData::Inline(bytes) => Ok(Self {
                data: bytes.clone(),
                name: document.name().map(str::to_string),
            }),
            DocumentData::Reference(_) => Err(EngineError::new(
                ErrorCode::InvalidInput,
                "rotate requires inline document bytes, not a storage reference",
            )),
        }
    }
}

/// Options for [`RotateOperation`]: which pages to rotate and by how much.
/// No range-string parsing happens here (or anywhere in the core); higher
/// layers produce these structured values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotateOptions {
    /// Pages to rotate, 1-based. Need not cover the document; order is
    /// irrelevant. Duplicates are rejected, not deduplicated. Empty means
    /// rotate nothing (independent full copy).
    pub pages: Vec<PageNumber>,
    /// Relative rotation in integer degrees. Must be equivalent to a
    /// multiple of 90° (`450` behaves as `90`, `-90` as `270`); `0` is a
    /// valid no-op. Validated during execution before anything is built.
    pub angle_deg: i32,
}

impl RotateOptions {
    /// Creates options from a page list and a relative angle. Range,
    /// duplicates, and angle validity are all checked during execution.
    #[must_use]
    pub const fn new(pages: Vec<PageNumber>, angle_deg: i32) -> Self {
        Self { pages, angle_deg }
    }
}

/// Output of [`RotateOperation`]: the rotated document.
///
/// Holds the parsed result so it can be inspected further, passed to
/// another operation, or serialized via [`PdfDocument::save_to_bytes`]
/// for file output / WASM transfer.
#[derive(Debug)]
pub struct RotateOutput {
    /// The output document with selected pages rotated.
    pub document: PdfDocument,
    /// Page count of the output document (always equals the input page
    /// count, since rotation never adds or removes pages).
    pub page_count: u32,
}

/// Rotates selected pages via a full deep copy plus per-page `/Rotate`
/// materialization. Single engine execution, single lifecycle.
#[derive(Debug, Default)]
pub struct RotateOperation;

impl Operation for RotateOperation {
    type Input = RotateInput;
    type Options = RotateOptions;
    type Output = RotateOutput;

    fn name(&self) -> &'static str {
        "pdf.rotate"
    }

    fn capabilities(&self) -> OperationCapabilities {
        // Sequential today; the per-page copy loop is the natural unit for
        // future bounded parallelism once baselines exist.
        OperationCapabilities::parallel_friendly()
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        options: Self::Options,
    ) -> Result<Self::Output, EngineError> {
        ctx.report_progress(
            Some("validating"),
            5,
            100,
            Some("validating rotation request"),
        );
        ctx.check_cancellation()?;

        // Cheap option validation before touching the document.
        let angle = normalize_quarter_turn(options.angle_deg).ok_or_else(|| {
            EngineError::new(
                ErrorCode::InvalidInput,
                format!(
                    "rotate angle must be a multiple of 90 degrees, got {}",
                    options.angle_deg,
                ),
            )
            .with_details(format!("angle_deg={}", options.angle_deg))
        })?;

        let source = load_pdf(&input.data)?;
        ctx.report_progress(Some("preparing"), 10, 100, Some("parsing PDF structure"));
        ctx.check_cancellation()?;

        // Still-encrypted documents need a password, which is a later
        // lesson: fail cleanly instead of returning partial data.
        if source.is_encrypted() {
            return Err(EngineError::new(
                ErrorCode::UnsupportedFormat,
                "PDF is encrypted and requires a password",
            )
            .with_details("password-based decryption is not supported yet"));
        }

        // Validate the ENTIRE page list before constructing anything.
        validate_pages(&source, &options.pages)?;

        // Copying occupies the 10–80% band over all pages.
        let page_count = source.page_count();
        let mut document = copy_pages(&source, &all_pages(page_count), |done, total| {
            ctx.check_cancellation()?;
            let completed = 10 + (done as u64 * 70) / (total as u64).max(1);
            ctx.report_progress(
                Some("copying pages"),
                completed.min(80),
                100,
                Some(&format!("page {done} of {total}")),
            );
            Ok(())
        })?;

        // Applying rotations occupies the 80–95% band over selected pages.
        let selected = options.pages.len();
        for (index, page_number) in options.pages.iter().enumerate() {
            ctx.check_cancellation()?;
            let base = document.effective_rotation(*page_number)?;
            let rotated = (base + angle).rem_euclid(360);
            debug_assert_eq!(rotated % 90, 0, "quarter-turn inputs stay quarter-turn");
            document.set_page_rotation(*page_number, rotated)?;
            let completed = 80 + ((index + 1) as u64 * 15) / (selected as u64).max(1);
            ctx.report_progress(
                Some("applying rotations"),
                completed.min(95),
                100,
                Some(&format!("page {} of {selected}", index + 1)),
            );
        }
        if selected == 0 {
            ctx.report_progress(
                Some("applying rotations"),
                95,
                100,
                Some("no pages selected"),
            );
        }

        ctx.check_cancellation()?;
        ctx.report_progress(Some("finalizing"), 100, 100, Some("rotate complete"));
        let page_count = document.page_count();
        Ok(RotateOutput {
            document,
            page_count,
        })
    }
}

/// The full 1-based page list `1..=page_count`. Rotation always copies the
/// whole document first (independent output), then adjusts only selected
/// pages — so even an empty selection flows through one uniform path.
fn all_pages(page_count: u32) -> Vec<PageNumber> {
    (1..=page_count).collect()
}

/// Validates the rotation page list against the document before anything
/// is constructed. Empty is allowed (no-op); range and duplicates are
/// rejected. Checks run in a fixed order — range, then duplicates — so the
/// reported error is deterministic. Entry/position numbers in messages are
/// 1-based for humans; details carry the same fields in `key=value` form
/// for machines.
fn validate_pages(source: &PdfDocument, pages: &[PageNumber]) -> Result<(), EngineError> {
    let page_count = source.page_count();
    if let Some((entry_index, page_number)) = find_invalid_page(source, pages) {
        let entry_number = entry_index + 1;
        return Err(EngineError::new(
            ErrorCode::PageOutOfRange,
            format!(
                "rotate entry {entry_number} references page {page_number}, \
                 but the document contains only {page_count} pages"
            ),
        )
        .with_details(format!(
            "entry={entry_number} page={page_number} page_count={page_count}"
        )));
    }
    let mut seen = HashSet::with_capacity(pages.len());
    for (entry_index, page_number) in pages.iter().enumerate() {
        if !seen.insert(page_number) {
            let first = pages
                .iter()
                .position(|entry| entry == page_number)
                .map(|position| position + 1)
                .unwrap_or(1);
            let duplicate_number = entry_index + 1;
            return Err(EngineError::new(
                ErrorCode::DuplicatePage,
                format!("page {page_number} appears more than once in the rotation list"),
            )
            .with_details(format!(
                "page={page_number} first_position={first} \
                 duplicate_position={duplicate_number} page_count={page_count}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::core::fixtures;
    use super::super::core::loader::load_pdf;
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
            "pdf.rotate"
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

    /// Context that cancels after a fixed number of successful checks, so
    /// mid-operation cancellation is deterministic: the first two checks
    /// (validating, preparing) pass, the third — inside page copying —
    /// fails.
    struct CancelMidwayCtx {
        id: JobId,
        remaining: std::cell::Cell<usize>,
        max_completed: std::cell::Cell<u64>,
    }

    impl OperationContext for CancelMidwayCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.rotate"
        }
        fn report_progress(
            &self,
            _phase: Option<&str>,
            completed: u64,
            _total: u64,
            _message: Option<&str>,
        ) {
            let max = self.max_completed.get().max(completed);
            self.max_completed.set(max);
        }
        fn is_cancelled(&self) -> bool {
            self.remaining.get() == 0
        }
        fn check_cancellation(&self) -> Result<(), EngineError> {
            let left = self.remaining.get();
            if left == 0 {
                return Err(EngineError::cancelled(&self.id, "pdf.rotate"));
            }
            self.remaining.set(left - 1);
            Ok(())
        }
    }

    /// Context recording every reported percentage, for monotonicity and
    /// exact-completion assertions.
    struct RecordingCtx {
        id: JobId,
        events: std::cell::RefCell<Vec<u64>>,
    }

    impl OperationContext for RecordingCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.rotate"
        }
        fn report_progress(
            &self,
            _phase: Option<&str>,
            completed: u64,
            _total: u64,
            _message: Option<&str>,
        ) {
            self.events.borrow_mut().push(completed);
        }
        fn is_cancelled(&self) -> bool {
            false
        }
        fn check_cancellation(&self) -> Result<(), EngineError> {
            Ok(())
        }
    }

    fn ctx() -> NullCtx {
        NullCtx { id: JobId::new() }
    }

    fn input(bytes: Vec<u8>) -> RotateInput {
        RotateInput::from_bytes(bytes).expect("input builds")
    }

    /// Runs a rotation and re-parses the serialized output, returning the
    /// fresh document for structural assertions.
    fn rotate_and_reparse(bytes: Vec<u8>, pages: &[PageNumber], angle: i32) -> PdfDocument {
        let mut out = RotateOperation
            .execute(
                &ctx(),
                input(bytes),
                RotateOptions::new(pages.to_vec(), angle),
            )
            .expect("rotation succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        load_pdf(&serialized).expect("output re-parses")
    }

    fn rotations(doc: &PdfDocument, count: u32) -> Vec<i32> {
        (1..=count)
            .map(|n| doc.effective_rotation(n).expect("rotation readable"))
            .collect()
    }

    #[test]
    fn rotates_all_pages_by_90() {
        let reparsed = rotate_and_reparse(fixtures::mixed_pages_pdf(), &[1, 2, 3], 90);
        assert_eq!(reparsed.page_count(), 3);
        // Source effective rotations [0, 90, 270] advance by 90.
        assert_eq!(rotations(&reparsed, 3), vec![90, 180, 0]);
    }

    #[test]
    fn rotates_by_180_and_270() {
        let reparsed = rotate_and_reparse(fixtures::mixed_pages_pdf(), &[1, 2, 3], 180);
        assert_eq!(rotations(&reparsed, 3), vec![180, 270, 90]);
        let reparsed = rotate_and_reparse(fixtures::mixed_pages_pdf(), &[1, 2, 3], 270);
        assert_eq!(rotations(&reparsed, 3), vec![270, 0, 180]);
    }

    #[test]
    fn negative_rotation_wraps() {
        let reparsed = rotate_and_reparse(fixtures::mixed_pages_pdf(), &[1, 2, 3], -90);
        assert_eq!(rotations(&reparsed, 3), vec![270, 0, 180]);
        let reparsed = rotate_and_reparse(fixtures::mixed_pages_pdf(), &[1], -180);
        assert_eq!(rotations(&reparsed, 1)[..1], vec![180]);
        // Spec example: existing 90° with -180° yields 270°.
        let reparsed = rotate_and_reparse(fixtures::mixed_pages_pdf(), &[2], -180);
        assert_eq!(rotations(&reparsed, 3)[1..2], vec![270]);
    }

    #[test]
    fn equivalent_angles_behave_identically() {
        for (angle, expected_first) in [(360, 0), (450, 90), (-360, 0), (720, 0)] {
            let reparsed = rotate_and_reparse(fixtures::single_page_pdf(), &[1], angle);
            assert_eq!(
                rotations(&reparsed, 1),
                vec![expected_first],
                "angle {angle}"
            );
        }
    }

    #[test]
    fn rejects_non_quarter_turn_angles() {
        for angle in [45, -45, 135, 30, 17, 91] {
            let err = RotateOperation
                .execute(
                    &ctx(),
                    input(fixtures::single_page_pdf()),
                    RotateOptions::new(vec![1], angle),
                )
                .expect_err("angle must fail");
            assert_eq!(err.code(), ErrorCode::InvalidInput, "angle {angle}");
            assert!(err.message().contains(&angle.to_string()));
            assert!(err.details().is_some());
        }
    }

    #[test]
    fn partial_selection_leaves_others_untouched() {
        let reparsed = rotate_and_reparse(fixtures::five_page_pdf(), &[2, 4], 90);
        assert_eq!(reparsed.page_count(), 5);
        // Source effective: [0, 90, 270, 180, 0]; pages 2 and 4 advance.
        assert_eq!(rotations(&reparsed, 5), vec![0, 180, 270, 270, 0]);
    }

    #[test]
    fn unsorted_selection_applies_regardless_of_order() {
        let reparsed = rotate_and_reparse(fixtures::five_page_pdf(), &[5, 2, 4], 90);
        assert_eq!(rotations(&reparsed, 5), vec![0, 180, 270, 270, 90]);
    }

    #[test]
    fn rejects_duplicate_selection() {
        let err = RotateOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                RotateOptions::new(vec![2, 2, 4], 90),
            )
            .expect_err("duplicate must fail");
        assert_eq!(err.code(), ErrorCode::DuplicatePage);
        assert_eq!(err.code().code_str(), "DUPLICATE_PAGE");
        let details = err.details().expect("structured details");
        assert!(details.contains("page=2"));
        assert!(details.contains("first_position=1"));
        assert!(details.contains("duplicate_position=2"));
    }

    #[test]
    fn empty_selection_is_independent_noop() {
        let bytes = fixtures::mixed_pages_pdf();
        let out = RotateOperation
            .execute(&ctx(), input(bytes), RotateOptions::new(vec![], 90))
            .expect("empty selection succeeds");
        assert_eq!(out.page_count, 3);
        let mut doc = out.document;
        let serialized = doc.save_to_bytes().expect("serializes");
        let reparsed = load_pdf(&serialized).expect("re-parses");
        assert_eq!(rotations(&reparsed, 3), vec![0, 90, 270]);
    }

    #[test]
    fn zero_degree_is_independent_noop() {
        let out = RotateOperation
            .execute(
                &ctx(),
                input(fixtures::mixed_pages_pdf()),
                RotateOptions::new(vec![1, 2], 0),
            )
            .expect("zero degrees succeeds");
        assert_eq!(out.page_count, 3);
        let mut doc = out.document;
        let serialized = doc.save_to_bytes().expect("serializes");
        let reparsed = load_pdf(&serialized).expect("re-parses");
        assert_eq!(rotations(&reparsed, 3), vec![0, 90, 270]);
    }

    #[test]
    fn rejects_page_zero() {
        let err = RotateOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                RotateOptions::new(vec![0], 90),
            )
            .expect_err("zero must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("entry 1"));
    }

    #[test]
    fn rejects_out_of_range_page() {
        let err = RotateOperation
            .execute(
                &ctx(),
                input(fixtures::five_page_pdf()),
                RotateOptions::new(vec![999], 90),
            )
            .expect_err("out of range must fail");
        assert_eq!(err.code(), ErrorCode::PageOutOfRange);
        assert!(err.message().contains("999"));
        let details = err.details().expect("structured details");
        assert!(details.contains("page=999"));
        assert!(details.contains("page_count=5"));
    }

    #[test]
    fn reports_first_problem_deterministically() {
        // Range is checked before duplicates: a list containing both
        // reports the range problem first, every time.
        for _ in 0..2 {
            let err = RotateOperation
                .execute(
                    &ctx(),
                    input(fixtures::five_page_pdf()),
                    RotateOptions::new(vec![2, 2, 999], 90),
                )
                .expect_err("must fail");
            assert_eq!(err.code(), ErrorCode::PageOutOfRange);
            assert!(err.message().contains("999"));
        }
    }

    #[test]
    fn inherited_rotation_resolves_and_materializes() {
        let mut spec = fixtures::pdf_spec(
            "1.4",
            vec![
                (612.0, 792.0, None),
                (612.0, 792.0, None),
                (612.0, 792.0, None),
            ],
            None,
        );
        spec.pages_rotate = Some(90);
        let bytes = fixtures::build_pdf(&spec);
        let reparsed = rotate_and_reparse(bytes, &[2], 90);
        assert_eq!(rotations(&reparsed, 3), vec![90, 180, 90]);
    }

    #[test]
    fn mixed_rotation_each_page_exact() {
        let mut spec = fixtures::pdf_spec(
            "1.4",
            vec![
                (612.0, 792.0, None),
                (612.0, 792.0, Some(180)),
                (612.0, 792.0, None),
            ],
            None,
        );
        spec.pages_rotate = Some(90);
        let bytes = fixtures::build_pdf(&spec);
        // Page 1 (inherited 90) +90 → 180.
        let reparsed = rotate_and_reparse(bytes.clone(), &[1], 90);
        assert_eq!(rotations(&reparsed, 3), vec![180, 180, 90]);
        // Page 3 (inherited 90) +180 → 270; page 2 (direct 180) untouched.
        let reparsed = rotate_and_reparse(bytes, &[3], 180);
        assert_eq!(rotations(&reparsed, 3), vec![90, 180, 270]);
    }

    #[test]
    fn shared_ancestor_is_never_mutated() {
        let mut spec = fixtures::pdf_spec(
            "1.4",
            vec![
                (612.0, 792.0, None),
                (612.0, 792.0, None),
                (612.0, 792.0, None),
            ],
            None,
        );
        spec.pages_rotate = Some(90);
        let bytes = fixtures::build_pdf(&spec);
        let reparsed = rotate_and_reparse(bytes, &[2], 90);
        // Pages 1 and 3 still show exactly the inherited 90°.
        assert_eq!(rotations(&reparsed, 3), vec![90, 180, 90]);
    }

    #[test]
    fn source_document_is_untouched() {
        let bytes = fixtures::mixed_pages_pdf();
        let before = bytes.clone();
        let source = load_pdf(&bytes).expect("fixture loads");
        let source_rotations: Vec<i32> = (1..=3)
            .map(|n| source.effective_rotation(n).expect("readable"))
            .collect();
        let out = RotateOperation
            .execute(
                &ctx(),
                input(bytes.clone()),
                RotateOptions::new(vec![2], 90),
            )
            .expect("rotation succeeds");
        assert_eq!(bytes, before);
        assert_eq!(source.page_count(), 3);
        let after: Vec<i32> = (1..=3)
            .map(|n| source.effective_rotation(n).expect("readable"))
            .collect();
        assert_eq!(source_rotations, after);
        assert_eq!(after, vec![0, 90, 270]);
        let mut doc = out.document;
        let serialized = doc.save_to_bytes().expect("serializes");
        let reparsed = load_pdf(&serialized).expect("re-parses");
        assert_eq!(rotations(&reparsed, 3), vec![0, 180, 270]);
        // Source bytes still reload to the original rotations.
        let reloaded = load_pdf(&before).expect("re-parses");
        let reloaded_rotations: Vec<i32> = (1..=3)
            .map(|n| reloaded.effective_rotation(n).expect("readable"))
            .collect();
        assert_eq!(reloaded_rotations, vec![0, 90, 270]);
    }

    #[test]
    fn content_and_geometry_survive_rotation() {
        let texts = ["PAGE 1", "PAGE 2", "PAGE 3"];
        let bytes = fixtures::text_pages_pdf(&texts);
        let mut out = RotateOperation
            .execute(&ctx(), input(bytes), RotateOptions::new(vec![2], 90))
            .expect("rotation succeeds")
            .document;
        let serialized = out.save_to_bytes().expect("output serializes");
        let raw = lopdf::Document::load_mem(&serialized).expect("output re-parses");
        assert_eq!(raw.get_pages().len(), 3);
        for (output_index, expected) in texts.iter().enumerate() {
            let page_number = (output_index + 1) as u32;
            let page_id = raw.get_pages()[&page_number];
            let content = raw.get_page_content(page_id);
            let text = String::from_utf8_lossy(&content);
            assert!(
                text.contains(expected),
                "output page {page_number} shows {expected}: {text}"
            );
        }
        // Geometry untouched; only rotation changed.
        let reparsed = load_pdf(&serialized).expect("re-parses");
        for n in 1..=3 {
            let geometry = reparsed.page_geometry(n).expect("readable");
            assert!((geometry.width_pt - 612.0).abs() < f64::EPSILON);
            assert!((geometry.height_pt - 792.0).abs() < f64::EPSILON);
        }
        assert_eq!(rotations(&reparsed, 3), vec![0, 90, 0]);
    }

    #[test]
    fn preserves_metadata_and_version() {
        let reparsed = rotate_and_reparse(fixtures::mixed_pages_pdf(), &[2], 90);
        assert_eq!(reparsed.pdf_version(), "1.7");
        let meta = reparsed.metadata();
        assert_eq!(meta.title.as_deref(), Some("Mixed Pages"));
        assert_eq!(meta.author.as_deref(), Some("folio-engine fixtures"));
    }

    #[test]
    fn malformed_input_fails_cleanly() {
        let err = RotateOperation
            .execute(
                &ctx(),
                input(b"not a pdf".to_vec()),
                RotateOptions::new(vec![1], 90),
            )
            .expect_err("malformed must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn locked_pdf_fails_cleanly() {
        let err = RotateOperation
            .execute(
                &ctx(),
                input(fixtures::build_locked_pdf()),
                RotateOptions::new(vec![1], 90),
            )
            .expect_err("locked must fail");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
    }

    #[test]
    fn rejects_empty_and_reference_inputs() {
        assert!(RotateInput::from_bytes(Vec::new()).is_err());

        let reference = Document::from_reference(
            crate::core::document::DocumentId::new("doc-1").expect("id"),
            crate::core::document::MediaType::Pdf,
            None,
            128,
            "opfs://docs/abc",
        )
        .expect("reference builds");
        let err = RotateInput::from_document(&reference).expect_err("reference rejected");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn cancellation_aborts_before_construction() {
        let cancelled = CancelMidwayCtx {
            id: JobId::new(),
            remaining: std::cell::Cell::new(0),
            max_completed: std::cell::Cell::new(0),
        };
        let err = RotateOperation
            .execute(
                &cancelled,
                input(fixtures::five_page_pdf()),
                RotateOptions::new(vec![2, 4], 90),
            )
            .expect_err("cancelled must fail");
        assert_eq!(err.code(), ErrorCode::Cancelled);
    }

    #[test]
    fn cancellation_mid_copy_reports_no_completion() {
        // Two checks pass (validating, preparing); the third — inside page
        // copying — fails, so no output escapes and 100% is never reported.
        let ctx = CancelMidwayCtx {
            id: JobId::new(),
            remaining: std::cell::Cell::new(2),
            max_completed: std::cell::Cell::new(0),
        };
        let err = RotateOperation
            .execute(
                &ctx,
                input(fixtures::five_page_pdf()),
                RotateOptions::new(vec![1, 2, 3, 4, 5], 90),
            )
            .expect_err("mid-copy cancel must fail");
        assert_eq!(err.code(), ErrorCode::Cancelled);
        assert!(
            ctx.max_completed.get() < 100,
            "never reported completion: {}",
            ctx.max_completed.get()
        );
    }

    #[test]
    fn progress_reaches_exactly_100_monotonically() {
        let ctx = RecordingCtx {
            id: JobId::new(),
            events: std::cell::RefCell::new(Vec::new()),
        };
        RotateOperation
            .execute(
                &ctx,
                input(fixtures::five_page_pdf()),
                RotateOptions::new(vec![5, 2], 90),
            )
            .expect("rotation succeeds");
        let events = ctx.events.borrow();
        assert!(!events.is_empty());
        assert!(
            events.windows(2).all(|pair| pair[0] <= pair[1]),
            "{events:?}"
        );
        assert_eq!(*events.last().expect("events"), 100);
    }

    #[test]
    fn rotation_is_deterministic() {
        let bytes = fixtures::five_page_pdf();
        let run = || {
            let mut out = RotateOperation
                .execute(
                    &ctx(),
                    input(bytes.clone()),
                    RotateOptions::new(vec![5, 2], -90),
                )
                .expect("run succeeds")
                .document;
            out.save_to_bytes().expect("serializes")
        };
        assert_eq!(run(), run());
    }
}
