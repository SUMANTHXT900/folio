//! Metadata whitespace regression test through the engine.
//!
//! Gap with no prior integration coverage: PDF date strings with
//! surrounding whitespace (legal producers emit them; strict parsers
//! reject them). The read path trims before parsing, so a padded date
//! must decode to the same typed date as its exact form. The BOM path
//! (UTF-16BE titles) is already pinned by `reads_rich_metadata_through
//! _the_engine` in `pdf_metadata.rs` and is deliberately not duplicated.

use folio_engine::processing::pdf::metadata::{
    PdfDate, ReadMetadataInput, ReadMetadataOperation, ReadMetadataOptions,
};
use folio_engine::testing::pdf::{expect_success, run_operation};

/// One US Letter page plus an Info dict whose CreationDate is `date`.
fn pdf_with_creation_date(date: &str) -> Vec<u8> {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => content_id,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(vec![Object::from(page_id)]),
            "Count" => Object::from(1),
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);
    let info_id = doc.add_object(dictionary! {
        "CreationDate" => Object::string_literal(date.to_string()),
    });
    doc.trailer.set("Info", info_id);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

fn read_creation_date(bytes: Vec<u8>) -> Option<PdfDate> {
    let input = ReadMetadataInput::from_bytes(bytes).expect("input builds");
    let output = expect_success(run_operation(
        &ReadMetadataOperation,
        input,
        ReadMetadataOptions::new(),
    ));
    output.metadata.creation_date
}

#[test]
fn whitespace_padded_creation_date_parses() {
    let padded = read_creation_date(pdf_with_creation_date("  D:20200101000000Z  "));
    let exact = read_creation_date(pdf_with_creation_date("D:20200101000000Z"));
    let expected = PdfDate::new(2020, 1, 1, 0, 0, 0, 0).expect("date builds");
    assert_eq!(padded, Some(expected));
    assert_eq!(padded, exact);
}

#[test]
fn mixed_whitespace_padded_creation_date_parses() {
    let padded = read_creation_date(pdf_with_creation_date("\tD:20200101000000Z\n"));
    let expected = PdfDate::new(2020, 1, 1, 0, 0, 0, 0).expect("date builds");
    assert_eq!(padded, Some(expected));
}
