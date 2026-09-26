//! Loader cap regression tests through the public `load_pdf` boundary.
//!
//! The byte ceiling (100 MiB) and page ceiling (10 000) are covered by
//! unit tests inside the loader; these integration tests pin the same
//! behavior at the API every operation funnels through, asserting the
//! structured `InvalidInput` code and the `max_bytes=` / `max_pages=`
//! details operators rely on. No existing integration test touches
//! either cap.

use folio_engine::core::error::ErrorCode;
use folio_engine::processing::pdf::core::loader::load_pdf;

#[test]
fn rejects_input_one_byte_over_the_size_ceiling() {
    let huge = vec![0u8; 100 * 1024 * 1024 + 1];
    let err = load_pdf(&huge).expect_err("oversized input must fail");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    let details = err.details().expect("structured details");
    assert!(details.contains("max_bytes="), "{details}");
}

#[test]
fn rejects_document_one_page_over_the_page_ceiling() {
    use lopdf::{dictionary, Document, Object};

    // Lean fixture: page dicts carry only what the page-tree walk needs,
    // so 10 001 pages stay fast (same shape as the loader unit test).
    let over: u32 = 10_001;
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
