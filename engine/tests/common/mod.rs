//! Shared builders for integration tests.
//!
//! Small deterministic PDFs generated in memory with `lopdf`
//! (dev-dependency, test-only). Shapes mirror the unit-test fixtures in
//! `processing::pdf::core::fixtures` so both suites assert the same known
//! values; they cannot share code because that module is `#[cfg(test)]`
//! inside the library. The real-world `test pdfs/` corpus is never touched.
//!
//! Each integration test target compiles this module separately, so a
//! builder used by only one target would trip dead-code lints in the
//! others; the module-level allow below is deliberate.
#![allow(dead_code)]

use lopdf::{dictionary, Document, Object, Stream, StringFormat};

/// One page: `(width_pt, height_pt, rotation_deg)`.
type PageShape = (f32, f32, Option<i64>);

fn build_pdf(
    version: &str,
    pages: &[PageShape],
    title: Option<&str>,
    author: Option<&str>,
    pages_rotate: Option<i64>,
) -> Vec<u8> {
    let mut doc = Document::with_version(version);
    let pages_id = doc.new_object_id();

    let mut kids = Vec::with_capacity(pages.len());
    for (width, height, rotation) in pages {
        let mut page = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::from(*width),
                Object::from(*height),
            ],
        };
        if let Some(degrees) = rotation {
            page.set("Rotate", Object::from(*degrees));
        }
        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        page.set("Contents", Object::from(content_id));
        kids.push(Object::from(doc.add_object(page)));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary({
            let mut pages = dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(kids),
                "Count" => Object::from(pages.len() as i64),
            };
            if let Some(degrees) = pages_rotate {
                pages.set("Rotate", Object::from(degrees));
            }
            pages
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    if title.is_some() || author.is_some() {
        let mut info = dictionary! {};
        if let Some(title) = title {
            info.set("Title", utf16_string(title));
        }
        if let Some(author) = author {
            info.set("Author", Object::string_literal(author.to_string()));
        }
        let info_id = doc.add_object(info);
        doc.trailer.set("Info", info_id);
    }

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

/// Encodes text as a UTF-16BE string object with BOM.
fn utf16_string(text: &str) -> Object {
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

/// Named fixture: single US Letter page, PDF 1.7, no metadata.
pub fn single_page_pdf() -> Vec<u8> {
    build_pdf("1.7", &[(612.0, 792.0, None)], None, None, None)
}

/// Named fixture: US Letter + A4 rotated 90°, with title metadata.
pub fn multi_page_pdf() -> Vec<u8> {
    build_pdf(
        "1.7",
        &[(612.0, 792.0, None), (595.0, 842.0, Some(90))],
        Some("Integration"),
        None,
        None,
    )
}

/// Named fixture: three pages with different dimensions and rotations,
/// plus title/author metadata. Mirrors the unit-test mixed fixture.
pub fn mixed_pages_pdf() -> Vec<u8> {
    build_pdf(
        "1.7",
        &[
            (612.0, 792.0, None),
            (595.0, 842.0, Some(90)),
            (420.0, 595.0, Some(270)),
        ],
        Some("Mixed Pages"),
        Some("folio-engine fixtures"),
        None,
    )
}

/// Named fixture: five pages with distinct dimensions/rotations, no
/// metadata. Mirrors the unit-test fixture for multi-part splits.
pub fn five_page_pdf() -> Vec<u8> {
    build_pdf(
        "1.7",
        &[
            (612.0, 792.0, None),
            (595.0, 842.0, Some(90)),
            (420.0, 595.0, Some(270)),
            (612.0, 792.0, Some(180)),
            (500.0, 700.0, None),
        ],
        None,
        None,
        None,
    )
}

/// Named fixture: three pages without direct `/Rotate` under a Pages node
/// carrying `/Rotate 90`, so every page effectively shows 90°.
pub fn inherited_rotate_pdf() -> Vec<u8> {
    build_pdf(
        "1.4",
        &[
            (612.0, 792.0, None),
            (612.0, 792.0, None),
            (612.0, 792.0, None),
        ],
        None,
        None,
        Some(90),
    )
}

/// Named fixture: ancestor `/Rotate 90` plus page 2 direct `/Rotate 180`.
pub fn mixed_rotate_pdf() -> Vec<u8> {
    build_pdf(
        "1.4",
        &[
            (612.0, 792.0, None),
            (612.0, 792.0, Some(180)),
            (612.0, 792.0, None),
        ],
        None,
        None,
        Some(90),
    )
}

/// Named fixture: two US Letter pages with real text content
/// ("Alpha page one", "Beta page two"). Mirrors the unit-test fixture.
pub fn text_content_pdf() -> Vec<u8> {
    text_pages_pdf(&["Alpha page one", "Beta page two"])
}

/// Builds a PDF with one US Letter page per text, each page showing its
/// text with a standard Type1 font. Mirrors the unit-test builder.
pub fn text_pages_pdf(texts: &[&str]) -> Vec<u8> {
    use lopdf::content::{Content, Operation as ContentOp};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! {
            "F1" => font_id,
        },
    });

    let mut kids = Vec::new();
    for text in texts {
        let content = Content {
            operations: vec![
                ContentOp::new("BT", vec![]),
                ContentOp::new("Tf", vec!["F1".into(), 24.into()]),
                ContentOp::new("Td", vec![100.into(), 700.into()]),
                ContentOp::new("Tj", vec![Object::string_literal(*text)]),
                ContentOp::new("ET", vec![]),
            ],
        };
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            content.encode().expect("content encodes"),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => resources_id,
            "Contents" => content_id,
        });
        kids.push(Object::from(page_id));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => Object::from(texts.len() as i64),
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

/// Named fixture: one US Letter page with a 1x1 RGB image XObject.
/// Mirrors the unit-test fixture.
pub fn image_page_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let image_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => Object::from(1),
            "Height" => Object::from(1),
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => Object::from(8),
        },
        vec![255, 0, 0],
    ));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! {
            "Im1" => image_id,
        },
    });
    let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => resources_id,
        "Contents" => content_id,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::from(page_id)],
            "Count" => Object::from(1),
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

/// Named fixture: two text pages where page 1 carries a link annotation
/// with an explicit destination to page 2 (plus a `/P` back-reference).
/// Mirrors the unit-test fixture.
pub fn annotated_pdf() -> Vec<u8> {
    use lopdf::content::{Content, Operation as ContentOp};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! {
            "F1" => font_id,
        },
    });

    let mut kids = Vec::new();
    let mut page_ids = Vec::new();
    for text in ["Link source", "Link target"] {
        let content = Content {
            operations: vec![
                ContentOp::new("BT", vec![]),
                ContentOp::new("Tf", vec!["F1".into(), 24.into()]),
                ContentOp::new("Td", vec![100.into(), 700.into()]),
                ContentOp::new("Tj", vec![Object::string_literal(text)]),
                ContentOp::new("ET", vec![]),
            ],
        };
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            content.encode().expect("content encodes"),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => resources_id,
            "Contents" => content_id,
        });
        kids.push(Object::from(page_id));
        page_ids.push(page_id);
    }
    let annot_id = doc.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Link",
        "Rect" => vec![0.into(), 0.into(), 100.into(), 100.into()],
        "Dest" => vec![Object::from(page_ids[1]), Object::from("Fit")],
        "P" => page_ids[0],
    });
    doc.get_dictionary_mut(page_ids[0])
        .expect("page dict")
        .set("Annots", vec![Object::from(annot_id)]);
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => Object::from(2),
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

/// Named fixture: a structurally valid PDF with zero pages.
/// Mirrors the unit-test fixture.
pub fn empty_pages_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(vec![]),
            "Count" => Object::from(0),
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

/// Named fixture: one US Letter page with a full Info dictionary —
/// title, author, keywords, creator, and both dates. Mirrors the
/// unit-test metadata coverage for engine-path integration tests.
pub fn metadata_rich_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(612),
            Object::Integer(792),
        ],
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
        "Title" => utf16_string("Rich Metadata"),
        "Author" => Object::string_literal("Integration Author".to_string()),
        "Keywords" => Object::string_literal("alpha, beta".to_string()),
        "Creator" => utf16_string("Creator \u{e9}"),
        "CreationDate" => Object::string_literal("D:20260123093000+05'30'".to_string()),
        "ModDate" => Object::string_literal("D:20200101000000Z".to_string()),
    });
    doc.trailer.set("Info", info_id);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

/// Named fixture: one-page PDF locked with a real user password.
/// Mirrors the unit-test fixture; loading without a password succeeds
/// but leaves the document encrypted.
pub fn locked_pdf() -> Vec<u8> {
    use lopdf::{EncryptionState, EncryptionVersion, Permissions};

    let mut doc = Document::with_version("1.4");
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
            "Kids" => vec![Object::from(page_id)],
            "Count" => Object::from(1),
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);
    let file_id = Object::String(b"folio-engine-test!".to_vec(), StringFormat::Hexadecimal);
    doc.trailer
        .set("ID", Object::Array(vec![file_id.clone(), file_id]));
    let state = EncryptionState::try_from(EncryptionVersion::V1 {
        document: &doc,
        owner_password: "owner-password",
        user_password: "user-password",
        permissions: Permissions::PRINTABLE,
    })
    .expect("encryption state builds");
    doc.encrypt(&state).expect("fixture encrypts");

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}
