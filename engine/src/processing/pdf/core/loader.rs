//! PDF loader: raw bytes in, [`PdfDocument`] out.
//!
//! Works purely with byte slices — never with filesystem paths, browser
//! APIs, or storage handles. `lopdf` failures are translated into the
//! engine's structured [`EngineError`] at this boundary and never leak.

use crate::core::error::{EngineError, ErrorCode};
use crate::processing::pdf::core::document::PdfDocument;

/// Maximum accepted input size (100 MiB). `lopdf` allocates multiples of
/// the input while parsing; bounding the bytes up front keeps pathological
/// inputs from exhausting mobile (WASM) memory mid-parse. Also bounds the
/// combined merge input (see `pdf.merge`).
pub(crate) const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;

/// Maximum accepted page count (10 000). Page-tree walks and per-page
/// operations scale with this; the ceiling keeps them proportionate to
/// mobile memory and time budgets.
const MAX_PDF_PAGES: u32 = 10_000;

/// Parses PDF bytes into a [`PdfDocument`].
///
/// The input slice is only borrowed: the parsed document owns its own
/// structures, and the caller's buffer is never mutated. No additional
/// full-size copies of the input are made on top of what `lopdf` itself
/// allocates while parsing.
///
/// Oversized inputs (byte length, page count) fail as `InvalidInput:
/// they are caller-input problems, not malformed documents.
pub fn load_pdf(bytes: &[u8]) -> Result<PdfDocument, EngineError> {
    if bytes.is_empty() {
        // Empty input is a caller-input problem (same family as every
        // operation's `Input::from_bytes` rejection), not a malformed
        // document: there is nothing to parse.
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            "PDF bytes must not be empty",
        ));
    }
    if bytes.len() > MAX_PDF_BYTES {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            "PDF input exceeds the supported size",
        )
        .with_details(format!("bytes={} max_bytes={MAX_PDF_BYTES}", bytes.len())));
    }
    let document = match lopdf::Document::load_mem(bytes) {
        Ok(document) => {
            let mut doc = PdfDocument::from_lopdf(document);
            doc.set_source_byte_len(bytes.len());
            doc
        }
        Err(err) => {
            return Err(EngineError::new(
                ErrorCode::InvalidDocument,
                "input is not a readable PDF document",
            )
            .with_details(truncated_cause(&err)));
        }
    };
    let page_count = document.page_count();
    if page_count > MAX_PDF_PAGES {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            "PDF input exceeds the supported page count",
        )
        .with_details(format!("page_count={page_count} max_pages={MAX_PDF_PAGES}")));
    }
    Ok(document)
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
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn records_source_byte_length_for_size_gates() {
        let bytes =
            fixtures::build_pdf(&fixtures::pdf_spec("1.7", vec![(612.0, 792.0, None)], None));
        let doc = load_pdf(&bytes).expect("valid fixture loads");
        assert_eq!(doc.source_byte_len(), Some(bytes.len()));
    }

    #[test]
    fn rejects_oversized_byte_input_without_parsing() {
        // One byte over the cap: rejected as caller input, never parsed.
        let huge = vec![0u8; MAX_PDF_BYTES + 1];
        let err = load_pdf(&huge).expect_err("oversized input must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        let details = err.details().expect("structured details");
        assert!(details.contains("max_bytes="), "{details}");
    }

    #[test]
    fn rejects_documents_over_page_ceiling() {
        use lopdf::{dictionary, Document, Object};

        // Lean multi-thousand-page fixture: page dicts carry only what
        // the page-tree walk needs, so the test stays fast.
        let over = MAX_PDF_PAGES + 1;
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::with_capacity(over as usize);
        for _ in 0..over {
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            });
            kids.push(Object::from(page_id));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(kids),
                "Count" => Object::from(over as i64),
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("fixture serializes");

        let err = load_pdf(&bytes).expect_err("over-ceiling must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        let details = err.details().expect("structured details");
        assert!(details.contains("page_count=10001"), "{details}");
        assert!(details.contains("max_pages="), "{details}");
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
