//! PDF loader: raw bytes in, [`PdfDocument`] out.
//!
//! Works purely with byte slices — never with filesystem paths, browser
//! APIs, or storage handles. `lopdf` failures are translated into the
//! engine's structured [`EngineError`] at this boundary and never leak.

use crate::core::error::{EngineError, ErrorCode};
use crate::processing::pdf::core::document::PdfDocument;

/// Parses PDF bytes into a [`PdfDocument`].
///
/// The input slice is only borrowed: the parsed document owns its own
/// structures, and the caller's buffer is never mutated. No additional
/// full-size copies of the input are made on top of what `lopdf` itself
/// allocates while parsing.
pub fn load_pdf(bytes: &[u8]) -> Result<PdfDocument, EngineError> {
    if bytes.is_empty() {
        return Err(EngineError::new(
            ErrorCode::InvalidDocument,
            "PDF bytes must not be empty",
        ));
    }
    match lopdf::Document::load_mem(bytes) {
        Ok(document) => Ok(PdfDocument::from_lopdf(document)),
        Err(err) => Err(EngineError::new(
            ErrorCode::InvalidDocument,
            "input is not a readable PDF document",
        )
        .with_details(truncated_cause(&err))),
    }
}

/// Keeps the underlying cause debuggable without dumping unbounded parser
/// output into the error.
fn truncated_cause(err: &lopdf::Error) -> String {
    const LIMIT: usize = 500;
    let text = err.to_string();
    if text.len() <= LIMIT {
        text
    } else {
        format!("{}…", &text[..LIMIT])
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures;
    use super::*;

    #[test]
    fn loads_valid_pdf() {
        let bytes =
            fixtures::build_pdf(&fixtures::pdf_spec("1.7", vec![(612.0, 792.0, None)], None));
        let before = bytes.clone();
        let doc = load_pdf(&bytes).expect("valid fixture loads");
        assert_eq!(doc.page_count(), 1);
        // Read-only guarantee: the caller's buffer is untouched.
        assert_eq!(bytes, before);
    }

    #[test]
    fn loads_locked_pdf_and_reports_encryption() {
        let bytes = fixtures::build_locked_pdf();
        let doc = load_pdf(&bytes).expect("locked fixture loads structurally");
        assert!(doc.is_encrypted());
    }

    #[test]
    fn rejects_empty_input() {
        let err = load_pdf(&[]).expect_err("empty input must fail");
        assert_eq!(err.code(), ErrorCode::InvalidDocument);
    }

    #[test]
    fn rejects_malformed_input_without_panicking() {
        for bad in [
            b"definitely not a pdf".as_slice(),
            b"%PDF-1.7 truncated".as_slice(),
            &[0, 1, 2, 3, 255, 254],
        ] {
            let err = load_pdf(bad).expect_err("malformed input must fail");
            assert_eq!(err.code(), ErrorCode::InvalidDocument);
            assert!(err.details().is_some());
        }
    }
}
