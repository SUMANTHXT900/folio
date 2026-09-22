//! Deterministic in-memory PDF fixtures for unit tests.
//!
//! Test-only builders using `lopdf`'s writer API. Small, fast, and fully
//! controlled (page sizes, rotation, metadata, inheritance). The real-world
//! `test-pdfs/` corpus is never touched by automated tests.

use lopdf::{dictionary, Document, Object, Stream, StringFormat};

/// Optional Info-dictionary entries for a fixture.
#[derive(Debug, Default)]
pub struct InfoSpec {
    /// Title, written as UTF-16BE so metadata decoding is exercised.
    pub title: Option<String>,
    /// Author, written as a literal string.
    pub author: Option<String>,
    /// Subject, written as UTF-16BE.
    pub subject: Option<String>,
    /// Keywords, written as a literal string.
    pub keywords: Option<String>,
    /// Creator, written as UTF-16BE.
    pub creator: Option<String>,
    /// Producer, written as a literal string.
    pub producer: Option<String>,
    /// Creation date, written as a literal PDF date string.
    pub creation_date: Option<String>,
    /// Modification date, written as a literal PDF date string.
    pub modification_date: Option<String>,
}

/// Shape of one fixture page: `(width_pt, height_pt, rotation_deg)`.
pub type PageSpec = (f32, f32, Option<i64>);

/// Full fixture description.
#[derive(Debug)]
pub struct PdfSpec {
    /// PDF version string, e.g. `"1.7"`.
    pub version: &'static str,
    /// Pages in order.
    pub pages: Vec<PageSpec>,
    /// Optional Info dictionary.
    pub info: Option<InfoSpec>,
    /// When `true`, pages omit `/MediaBox` and the Pages node carries
    /// `612x792` instead, exercising inheritance.
    pub inherit_media_box: bool,
    /// Optional `/Rotate` on the Pages node (accumulates with page rotation).
    pub pages_rotate: Option<i64>,
}

/// Builds a [`PdfSpec`] concisely.
pub fn pdf_spec(version: &'static str, pages: Vec<PageSpec>, info: Option<InfoSpec>) -> PdfSpec {
    PdfSpec {
        version,
        pages,
        info,
        inherit_media_box: false,
        pages_rotate: None,
    }
}

/// Serializes a fixture spec to PDF bytes.
pub fn build_pdf(spec: &PdfSpec) -> Vec<u8> {
    let mut doc = build_document(spec);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

/// Named fixture: single US Letter page, PDF 1.7, no metadata.
pub fn single_page_pdf() -> Vec<u8> {
    build_pdf(&pdf_spec("1.7", vec![(612.0, 792.0, None)], None))
}

/// Named fixture: three pages with different dimensions and rotations,
/// plus title/author metadata. Covers the standard regression shapes.
pub fn mixed_pages_pdf() -> Vec<u8> {
    build_pdf(&pdf_spec(
        "1.7",
        vec![
            (612.0, 792.0, None),
            (595.0, 842.0, Some(90)),
            (420.0, 595.0, Some(270)),
        ],
        Some(InfoSpec {
            title: Some("Mixed Pages".to_string()),
            author: Some("folio-engine fixtures".to_string()),
            ..InfoSpec::default()
        }),
    ))
}

/// Named fixture: five pages with distinct dimensions/rotations, no
/// metadata. Covers multi-part splits with cross-part overlap.
pub fn five_page_pdf() -> Vec<u8> {
    build_pdf(&pdf_spec(
        "1.7",
        vec![
            (612.0, 792.0, None),
            (595.0, 842.0, Some(90)),
            (420.0, 595.0, Some(270)),
            (612.0, 792.0, Some(180)),
            (500.0, 700.0, None),
        ],
        None,
    ))
}

/// Named fixture: two US Letter pages with real text content
/// ("Alpha page one", "Beta page two") using a standard Type1 font.
///
/// Proves extraction carries page content, not just page structure.
pub fn text_content_pdf() -> Vec<u8> {
    text_pages_pdf(&["Alpha page one", "Beta page two"])
}

/// Builds a PDF with one US Letter page per text, each page showing its
/// text with a standard Type1 font. Used to verify content follows page
/// order through copy-based operations.
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
///
/// Proves image payloads and nested resource graphs survive copying.
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
///
/// Proves annotations stay attached and internal destinations are
/// remapped to the copied pages rather than orphaned shadow copies.
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
///
/// Exercises merge inputs that contribute nothing: skipped silently when
/// other inputs provide pages, rejected when every input is empty.
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

/// Builds a parsed `lopdf::Document` without serializing (for white-box tests).
pub fn parsed_fixture(spec: &PdfSpec) -> Document {
    build_document(spec)
}

/// Named fixture: one US Letter page carrying a catalog-level XMP metadata
/// stream alongside Info-dictionary entries.
///
/// Proves metadata edits preserve the XMP stream byte-for-byte without an
/// XMP editing subsystem: the writer path must carry unknown streams.
pub fn xmp_metadata_pdf() -> Vec<u8> {
    let spec = pdf_spec(
        "1.7",
        vec![(612.0, 792.0, None)],
        Some(InfoSpec {
            title: Some("XMP Carrier".to_string()),
            ..InfoSpec::default()
        }),
    );
    let mut doc = build_document(&spec);
    let xmp: &[u8] = b"<?xpacket begin='\xef\xbb\xbf' id='folio-test'?><x:xmpmeta/>  ";
    let stream_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "Metadata",
            "Subtype" => "XML",
        },
        xmp.to_vec(),
    ));
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .ok()
        .and_then(|obj| obj.as_reference().ok())
        .expect("fixture has a catalog");
    doc.get_dictionary_mut(catalog_id)
        .expect("catalog writable")
        .set("Metadata", stream_id);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).expect("fixture serializes");
    bytes
}

/// Reads the catalog `/Metadata` stream content of raw PDF bytes, if the
/// catalog references one. Used to prove XMP preservation across writes.
pub fn catalog_xmp_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let doc = Document::load_mem(bytes).ok()?;
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .ok()
        .and_then(|obj| obj.as_reference().ok())?;
    let metadata_id = doc
        .get_dictionary(catalog_id)
        .ok()?
        .get(b"Metadata")
        .ok()?
        .as_reference()
        .ok()?;
    doc.get_object(metadata_id)
        .ok()?
        .as_stream()
        .ok()
        .map(|stream| stream.content.clone())
}

/// Builds a one-page PDF locked with a real user password (`"user-password"`).
///
/// Loading it without a password succeeds but leaves it encrypted, which is
/// exactly the state `pdf.inspect` must reject cleanly.
pub fn build_locked_pdf() -> Vec<u8> {
    use lopdf::{EncryptionState, EncryptionVersion, Permissions};

    let spec = pdf_spec("1.4", vec![(612.0, 792.0, None)], None);
    let mut doc = build_document(&spec);
    // Encryption key derivation needs the trailer /ID present in real files.
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

fn build_document(spec: &PdfSpec) -> Document {
    let mut doc = Document::with_version(spec.version);
    let pages_id = doc.new_object_id();

    let mut kids = Vec::with_capacity(spec.pages.len());
    for (width, height, rotation) in &spec.pages {
        let mut page = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        };
        if !spec.inherit_media_box {
            page.set(
                "MediaBox",
                vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::from(*width),
                    Object::from(*height),
                ],
            );
        }
        if let Some(degrees) = rotation {
            page.set("Rotate", Object::from(*degrees));
        }
        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        page.set("Contents", Object::from(content_id));
        let page_id = doc.add_object(page);
        kids.push(Object::from(page_id));
    }

    let mut pages = dictionary! {
        "Type" => "Pages",
        "Kids" => Object::Array(kids),
        "Count" => Object::from(spec.pages.len() as i64),
    };
    if spec.inherit_media_box {
        pages.set(
            "MediaBox",
            vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(612),
                Object::Integer(792),
            ],
        );
    }
    if let Some(degrees) = spec.pages_rotate {
        pages.set("Rotate", Object::from(degrees));
    }
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    if let Some(info) = &spec.info {
        let mut dict = dictionary! {};
        if let Some(title) = &info.title {
            dict.set("Title", utf16_string(title));
        }
        if let Some(author) = &info.author {
            dict.set("Author", Object::string_literal(author.clone()));
        }
        if let Some(subject) = &info.subject {
            dict.set("Subject", utf16_string(subject));
        }
        if let Some(keywords) = &info.keywords {
            dict.set("Keywords", Object::string_literal(keywords.clone()));
        }
        if let Some(creator) = &info.creator {
            dict.set("Creator", utf16_string(creator));
        }
        if let Some(producer) = &info.producer {
            dict.set("Producer", Object::string_literal(producer.clone()));
        }
        if let Some(creation_date) = &info.creation_date {
            dict.set(
                "CreationDate",
                Object::string_literal(creation_date.clone()),
            );
        }
        if let Some(modification_date) = &info.modification_date {
            dict.set("ModDate", Object::string_literal(modification_date.clone()));
        }
        let info_id = doc.add_object(dict);
        doc.trailer.set("Info", info_id);
    }

    doc
}

/// Encodes text as a UTF-16BE string object with BOM.
fn utf16_string(text: &str) -> Object {
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}
