//! `pdf.images_to_pdf`: build one PDF from one or more images.
//!
//! Takes owned image bytes (JPEG/PNG) plus layout options and produces a
//! new [`PdfDocument`] with exactly one page per input image, in input
//! order. The frontend only reads file bytes and forwards them; all
//! validation, decoding, EXIF handling, DPI handling, layout, and PDF
//! construction live here so native and WASM share one implementation.
//!
//! Key policies (all deterministic, all documented):
//!
//! * **Formats:** JPEG/JPG and PNG via the `image` crate (features
//!   `jpeg`+`png` only). Anything else fails as `UNSUPPORTED_FORMAT`.
//! * **Pages:** 1 image → 1 page, N images → N pages, input order preserved.
//! * **Layout:** aspect ratio is never distorted. `FitImage` (default)
//!   sizes each page to the image's natural size (`px * 72 / dpi`);
//!   `StandardPage` uses fixed A4 (595.28 × 841.89 pt) with the image
//!   uniformly scaled to fit (`contain`) and centered.
//! * **DPI:** EXIF → JFIF (JPEG) / pHYs (PNG) → fallback `150`. Invalid or
//!   absent DPI uses the fallback. DPI sets the natural size, which sets
//!   `FitImage` page sizes and `StandardPage` drawn sizes.
//! * **EXIF orientation:** read from the original bytes (values 1–8) and
//!   applied to decoded pixels. Input bytes are never mutated.
//! * **JPEG handling:** baseline JPEGs with EXIF orientation 1 pass
//!   through untouched (`/DCTDecode` embedding — the PDF is a container,
//!   output ≈ input size, zero quality loss). Anything else (progressive,
//!   YCCK/CMYK surprises, EXIF-rotated) falls back to a single JPEG
//!   re-encode at [`FALLBACK_JPEG_QUALITY`]. PNGs keep the lossless raw
//!   path. Passthrough never guesses: unparseable frames fall back.
//! * **Transparency:** RGBA is composited against a configurable background
//!   (default white). No silent black backgrounds.
//! * **Atomicity:** the whole input list validates before construction; any
//!   per-image failure aborts with no partial PDF. Errors carry
//!   `image_index` (1-based) and `name` in message + details.
//! * **Safety:** dimensions validated via header probe with checked
//!   arithmetic before full decode; no panics on untrusted input.
//!
//! Never mutates the inputs. No filesystem, network, browser APIs,
//! user-facing compression options, or parallelism — sequential by design.

use image::ImageEncoder;
use lopdf::{dictionary, Stream};

use crate::core::error::{EngineError, ErrorCode};
use crate::core::operation::{Operation, OperationCapabilities, OperationContext};
use crate::processing::pdf::core::PdfDocument;

/// Default DPI when an image carries no valid DPI information.
pub const DEFAULT_DPI: f64 = 150.0;

/// Minimum/maximum sane DPI. Values outside are treated as absent.
const MIN_DPI: f64 = 1.0;
const MAX_DPI: f64 = 1200.0;

/// Maximum single image dimension in pixels (guards against absurd headers).
const MAX_IMAGE_DIMENSION: u32 = 30_000;

/// Maximum image pixels (width × height). 100 MP ≈ 300 MB raw RGB.
const MAX_IMAGE_PIXELS: u64 = 100_000_000;

/// JPEG quality for the fallback re-encode (non-passthrough JPEGs:
/// progressive, YCCK, EXIF-rotated). Internal constant, not a user
/// option — high enough that a single generation is visually
/// transparent, low enough to bound the worst case (~10× smaller than
/// raw RGB for photos).
const FALLBACK_JPEG_QUALITY: u8 = 82;

/// A4 page size in PDF points (ISO 216, 210 × 297 mm at 72 pt/in).
pub const A4_WIDTH_PT: f64 = 595.28;
pub const A4_HEIGHT_PT: f64 = 841.89;

/// Page-size policy for image placement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PageSizePolicy {
    /// Each page is sized to its image's natural size (`px * 72 / dpi`).
    /// The image fills the whole page. Deterministic default.
    #[default]
    FitImage,
    /// Fixed A4 page per image; the image is uniformly scaled to fit
    /// (`contain`) and centered. Aspect ratio is always preserved.
    StandardPage,
}

impl PageSizePolicy {
    /// Parses the WASM/CLI string form (`"fit"` / `"standard"`).
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "fit" | "fitimage" | "fit_image" => Some(Self::FitImage),
            "standard" | "standardpage" | "standard_page" | "a4" => Some(Self::StandardPage),
            _ => None,
        }
    }
}

/// One input image: owned bytes plus a diagnostic name.
#[derive(Debug, Clone)]
pub struct ImageInput {
    /// Original filename where known (diagnostics only, never a path).
    pub name: String,
    /// Raw image bytes. Owned so the signature stays `'static`; only
    /// borrowed downstream — never mutated.
    pub bytes: Vec<u8>,
}

impl ImageInput {
    /// Creates an input from bytes with a name.
    pub fn new(name: impl Into<String>, bytes: Vec<u8>) -> Result<Self, EngineError> {
        if bytes.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "image input bytes must not be empty",
            )
            .with_details(format!("name={}", name.into())));
        }
        Ok(Self {
            name: name.into(),
            bytes,
        })
    }
}

/// Input for [`ImagesToPdfOperation`]: one or more images in page order.
#[derive(Debug, Clone)]
pub struct ImagesToPdfInput {
    /// Images in output page order. Never sorted or deduplicated.
    pub images: Vec<ImageInput>,
    /// Optional human-readable label for diagnostics.
    pub name: Option<String>,
}

impl ImagesToPdfInput {
    /// Creates input from an image list. Emptiness is rejected during
    /// execution (so the engine attributes it), not here.
    #[must_use]
    pub fn new(images: Vec<ImageInput>) -> Self {
        Self { images, name: None }
    }
}

/// Options for [`ImagesToPdfOperation`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImagesToPdfOptions {
    /// Page sizing/placement policy.
    pub page_size: PageSizePolicy,
    /// Background for alpha compositing, `[R, G, B]`. Default white.
    pub background_rgb: [u8; 3],
}

impl ImagesToPdfOptions {
    /// Creates options with the given policy and background.
    #[must_use]
    pub const fn new(page_size: PageSizePolicy, background_rgb: [u8; 3]) -> Self {
        Self {
            page_size,
            background_rgb,
        }
    }

    /// Default options: `FitImage` pages, white background.
    #[must_use]
    pub const fn default_options() -> Self {
        Self {
            page_size: PageSizePolicy::FitImage,
            background_rgb: [255, 255, 255],
        }
    }
}

impl Default for ImagesToPdfOptions {
    fn default() -> Self {
        Self::default_options()
    }
}

/// Output of [`ImagesToPdfOperation`]: the generated document plus counts.
#[derive(Debug)]
pub struct ImagesToPdfOutput {
    /// The generated PDF, usable like any engine-side document.
    pub document: PdfDocument,
    /// Pages in the output (always equals the image count).
    pub page_count: u32,
    /// Images consumed (always equals the page count).
    pub image_count: u32,
}

/// Builds one PDF page per input image, in order.
#[derive(Debug, Default)]
pub struct ImagesToPdfOperation;

impl Operation for ImagesToPdfOperation {
    type Input = ImagesToPdfInput;
    type Options = ImagesToPdfOptions;
    type Output = ImagesToPdfOutput;

    fn name(&self) -> &'static str {
        "pdf.images_to_pdf"
    }

    fn capabilities(&self) -> OperationCapabilities {
        // Sequential today; per-image decode is the natural future unit.
        OperationCapabilities::parallel_friendly()
    }

    fn execute<C: OperationContext>(
        &self,
        ctx: &C,
        input: Self::Input,
        options: Self::Options,
    ) -> Result<Self::Output, EngineError> {
        ctx.report_progress(Some("validating"), 5, 100, Some("validating image list"));
        ctx.check_cancellation()?;

        if input.images.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidInput,
                "images_to_pdf requires at least one input image",
            )
            .with_details("image_count=0"));
        }
        for (index, image) in input.images.iter().enumerate() {
            if image.bytes.is_empty() {
                return Err(EngineError::new(
                    ErrorCode::InvalidInput,
                    format!("image {} (\"{}\") has empty bytes", index + 1, image.name),
                )
                .with_details(format!(
                    "image_index={} name={}",
                    index + 1,
                    image.name
                )));
            }
        }

        ctx.report_progress(Some("preparing"), 10, 100, Some("preparing destination"));
        ctx.check_cancellation()?;

        // Incremental embed (memory fix): decode ONE image, embed it into
        // the growing document, then release it before the next. Peak
        // decoded retention is one image, not N — critical at 12 MP
        // scale (36 MB × 30 pages no longer coexists). Page order follows
        // input order; outputs commit only after the last page succeeds,
        // so failure on page N still aborts with no partial PDF (atomic).
        let total = input.images.len() as u64;
        let mut pdf = PdfBuild::begin(input.images.len());
        for (index, image) in input.images.iter().enumerate() {
            ctx.check_cancellation()?;
            let item = decode_image(image, index, options.background_rgb)?;
            // `item` moves into the document here and drops at the end of
            // this iteration: peak decoded retention is one image
            // (passthrough clones are bounded JPEG bytes, not raw RGB).
            pdf.append(item, options.page_size)?;
            let completed = 10 + ((index as u64 + 1) * 80) / total.max(1);
            ctx.report_progress(
                Some("processing images"),
                completed.min(90),
                100,
                Some(&format!("image {} of {total}", index + 1)),
            );
        }

        ctx.check_cancellation()?;
        ctx.report_progress(
            Some("writing output"),
            95,
            100,
            Some("assembling PDF pages"),
        );

        let document = pdf.finish();

        ctx.check_cancellation()?;
        ctx.report_progress(Some("finalizing"), 100, 100, Some("images_to_pdf complete"));
        let page_count = input.images.len() as u32;
        Ok(ImagesToPdfOutput {
            document,
            page_count,
            image_count: page_count,
        })
    }
}

// ---------------------------------------------------------------------------
// Decoded image model
// ---------------------------------------------------------------------------

/// One fully decoded, EXIF-corrected, composited image ready for embedding.
struct DecodedImage {
    width_px: u32,
    height_px: u32,
    /// How the pixels travel into the PDF (raw RGB for PNGs, JPEG
    /// bytes for passthrough + fallback re-encodes).
    payload: ImagePayload,
    /// Detected (or fallback) DPI.
    dpi: f64,
}

/// Embedded pixel data: lossless raw RGB (PNG path) or JPEG bytes
/// (passthrough originals + fallback re-encodes) with their PDF
/// color space.
enum ImagePayload {
    RawRgb(Vec<u8>),
    Jpeg(JpegPayload),
}

/// JPEG bytes plus the dictionary entries they require.
struct JpegPayload {
    bytes: Vec<u8>,
    color_space: JpegColorSpace,
}

/// PDF color space for an embedded JPEG. `Cmyk` is Adobe APP14
/// transform-0 (inverted CMYK) and needs an inverting `/Decode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JpegColorSpace {
    Gray,
    Rgb,
    Cmyk,
}

impl JpegColorSpace {
    fn pdf_name(self) -> &'static str {
        match self {
            Self::Gray => "DeviceGray",
            Self::Rgb => "DeviceRGB",
            Self::Cmyk => "DeviceCMYK",
        }
    }
}

/// Validates headers, decodes, applies EXIF orientation, composites alpha,
/// and detects DPI. Input bytes are only borrowed, never mutated.
///
/// JPEG fast path: baseline RGB/gray/Adobe-CMYK frames with EXIF
/// orientation 1 are returned untouched (passthrough) — no decode, no
/// quality loss, output ≈ input size. Everything else decodes as before;
/// non-passthrough JPEGs are re-encoded once at
/// [`FALLBACK_JPEG_QUALITY`] so the worst case stays ~10× below raw RGB.
fn decode_image(
    image: &ImageInput,
    index: usize,
    background: [u8; 3],
) -> Result<DecodedImage, EngineError> {
    let image_number = index + 1;
    let tag = format!("image_index={image_number} name={}", image.name);

    // Fast header probe: validates dimensions with checked arithmetic
    // before committing to a full decode.
    let probe = image::ImageReader::new(std::io::Cursor::new(&image.bytes))
        .with_guessed_format()
        .map_err(|err| {
            map_image_error(&image.bytes, &err.to_string(), image_number, &image.name)
        })?;
    let (probe_w, probe_h) = probe.into_dimensions().map_err(|err| {
        map_image_error(&image.bytes, &err.to_string(), image_number, &image.name)
    })?;
    validate_dimensions(probe_w, probe_h, image_number, &image.name)?;

    // JPEG fast path first: orientation-1 baseline frames skip the
    // decode entirely. The frame dims must agree with the header probe
    // (paranoia against malformed SOF); anything doubtful falls through
    // to the decode path below.
    if is_jpeg_magic(&image.bytes) && read_exif_orientation(&image.bytes) == 1 {
        if let Some(frame) = parse_jpeg_frame(&image.bytes) {
            if frame.width == probe_w
                && frame.height == probe_h
                && jpeg_color_space(&frame).is_some()
            {
                validate_dimensions(frame.width, frame.height, image_number, &image.name)?;
                let dpi = detect_dpi(&image.bytes).unwrap_or(DEFAULT_DPI);
                let color_space = jpeg_color_space(&frame).expect("checked");
                return Ok(DecodedImage {
                    width_px: frame.width,
                    height_px: frame.height,
                    payload: ImagePayload::Jpeg(JpegPayload {
                        bytes: image.bytes.clone(),
                        color_space,
                    }),
                    dpi,
                });
            }
        }
    }

    let dynamic = image::load_from_memory(&image.bytes).map_err(|err| {
        map_image_error(&image.bytes, &err.to_string(), image_number, &image.name)
    })?;

    let orientation = read_exif_orientation(&image.bytes);
    let oriented = apply_exif_orientation(dynamic, orientation);
    let (width_px, height_px) = (oriented.width(), oriented.height());
    validate_dimensions(width_px, height_px, image_number, &image.name)?;

    // Checked allocation guard: w*h*3 must fit and stay under the cap.
    let pixels = u64::from(width_px)
        .checked_mul(u64::from(height_px))
        .ok_or_else(|| oversized_error(image_number, &image.name, &tag))?;
    if pixels == 0 || pixels > MAX_IMAGE_PIXELS {
        return Err(oversized_error(image_number, &image.name, &tag));
    }
    let needed = pixels.checked_mul(3).ok_or_else(|| {
        EngineError::new(
            ErrorCode::InvalidInput,
            format!(
                "image {image_number} (\"{}\") dimensions overflow RGB allocation",
                image.name
            ),
        )
        .with_details(tag.clone())
    })?;
    if needed > MAX_IMAGE_PIXELS * 3 {
        return Err(oversized_error(image_number, &image.name, &tag));
    }

    // Uniform RGBA → RGB compositing against the background. Handles RGB,
    // RGBA, grayscale, and grayscale+alpha identically; transparent pixels
    // take the background instead of silently going black.
    let rgba = oriented.to_rgba8();
    let (actual_w, actual_h) = (rgba.width(), rgba.height());
    debug_assert_eq!(actual_w, width_px);
    debug_assert_eq!(actual_h, height_px);
    let raw = rgba.as_raw();
    let mut rgb = Vec::with_capacity(needed as usize);
    let (br, bg, bb) = (
        u16::from(background[0]),
        u16::from(background[1]),
        u16::from(background[2]),
    );
    for pixel in raw.chunks_exact(4) {
        let (r, g, b, a) = (
            u16::from(pixel[0]),
            u16::from(pixel[1]),
            u16::from(pixel[2]),
            u16::from(pixel[3]),
        );
        // Blend: out = fg*a + bg*(255-a), rounded.
        let inv = 255 - a;
        rgb.push(((r * a + br * inv + 127) / 255) as u8);
        rgb.push(((g * a + bg * inv + 127) / 255) as u8);
        rgb.push(((b * a + bb * inv + 127) / 255) as u8);
    }

    let dpi = detect_dpi(&image.bytes).unwrap_or(DEFAULT_DPI);
    let is_jpeg = is_jpeg_magic(&image.bytes);
    let payload = if is_jpeg {
        // Fallback path (progressive, YCCK, EXIF-rotated): pixels are
        // already oriented + composited above, so one re-encode at the
        // fallback quality bounds the size. EXIF must NOT ride along
        // (fresh encoder output carries none — orientation is baked in).
        let mut encoded = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, FALLBACK_JPEG_QUALITY)
            .write_image(&rgb, width_px, height_px, image::ExtendedColorType::Rgb8)
            .map_err(|err| {
                EngineError::new(
                    ErrorCode::Internal,
                    format!(
                        "image {image_number} (\"{}\") fallback JPEG re-encode failed",
                        image.name
                    ),
                )
                .with_details(format!("image_index={image_number} reason={}", err))
            })?;
        ImagePayload::Jpeg(JpegPayload {
            bytes: encoded,
            color_space: JpegColorSpace::Rgb,
        })
    } else {
        ImagePayload::RawRgb(rgb)
    };
    Ok(DecodedImage {
        width_px,
        height_px,
        payload,
        dpi,
    })
}

fn oversized_error(image_number: usize, name: &str, tag: &str) -> EngineError {
    EngineError::new(
        ErrorCode::InvalidInput,
        format!("image {image_number} (\"{name}\") dimensions are unsupported or too large"),
    )
    .with_details(format!(
        "{tag} max_dimension={} max_pixels={}",
        MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS
    ))
}

fn validate_dimensions(
    width: u32,
    height: u32,
    image_number: usize,
    name: &str,
) -> Result<(), EngineError> {
    if width == 0 || height == 0 {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            format!("image {image_number} (\"{name}\") has invalid zero dimensions"),
        )
        .with_details(format!(
            "image_index={image_number} name={name} width={width} height={height}"
        )));
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(EngineError::new(
            ErrorCode::InvalidInput,
            format!("image {image_number} (\"{name}\") dimensions exceed the supported maximum"),
        )
        .with_details(format!(
            "image_index={image_number} name={name} width={width} height={height} \
             max_dimension={}",
            MAX_IMAGE_DIMENSION
        )));
    }
    let pixels = u64::from(width).checked_mul(u64::from(height));
    match pixels {
        Some(count) if count <= MAX_IMAGE_PIXELS => Ok(()),
        _ => Err(EngineError::new(
            ErrorCode::InvalidInput,
            format!("image {image_number} (\"{name}\") pixel count exceeds the supported maximum"),
        )
        .with_details(format!(
            "image_index={image_number} name={name} width={width} height={height} \
             max_pixels={}",
            MAX_IMAGE_PIXELS
        ))),
    }
}

/// Maps an `image`-crate failure to a structured engine error.
///
/// Unknown magic / unsupported codecs → `UNSUPPORTED_FORMAT`; matching
/// magic that fails to decode → `INVALID_DOCUMENT`. Both carry the
/// 1-based image index and name.
fn map_image_error(bytes: &[u8], reason: &str, image_number: usize, name: &str) -> EngineError {
    let known = is_jpeg_magic(bytes) || is_png_magic(bytes);
    let short = truncate_reason(reason);
    if known {
        EngineError::new(
            ErrorCode::InvalidDocument,
            format!("image {image_number} (\"{name}\") is corrupt or unreadable"),
        )
        .with_details(format!(
            "image_index={image_number} name={name} reason={short}"
        ))
    } else {
        EngineError::new(
            ErrorCode::UnsupportedFormat,
            format!(
                "image {image_number} (\"{name}\") format is not supported (expected JPEG or PNG)"
            ),
        )
        .with_details(format!(
            "image_index={image_number} name={name} reason={short}"
        ))
    }
}

fn truncate_reason(reason: &str) -> String {
    const LIMIT: usize = 300;
    let flat: String = reason.chars().take(LIMIT + 1).collect();
    if flat.len() > LIMIT {
        format!("{}…", &flat[..LIMIT])
    } else {
        flat
    }
}

fn is_jpeg_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
}

fn is_png_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[0..8] == [137, 80, 78, 71, 13, 10, 26, 10]
}

// ---------------------------------------------------------------------------
// JPEG frame parsing (passthrough gate)
// ---------------------------------------------------------------------------

/// Baseline JPEG frame header: dims + component count + Adobe flag.
/// Everything passthrough needs; parsed without decoding a pixel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct JpegFrame {
    width: u32,
    height: u32,
    components: u8,
    /// Adobe APP14 transform byte when present (`None` = no APP14).
    adobe_transform: Option<u8>,
}

/// Maps a parsed frame to its PDF color space. `None` means "do not
/// pass through" (YCCK, exotic component counts — fall back to the
/// re-encode path, which always produces plain RGB).
fn jpeg_color_space(frame: &JpegFrame) -> Option<JpegColorSpace> {
    match frame.components {
        1 => Some(JpegColorSpace::Gray),
        3 => Some(JpegColorSpace::Rgb),
        // Adobe transform 0 = inverted CMYK (needs an inverting
        // /Decode); transform 1 = YCCK, which viewers render
        // inconsistently — re-encode instead.
        4 if frame.adobe_transform == Some(0) => Some(JpegColorSpace::Cmyk),
        _ => None,
    }
}

/// Parses the first baseline SOF (C0/C1) of a JPEG, recording the Adobe
/// APP14 transform on the way. Returns `None` for progressive (C2 —
/// most PDF viewers cannot render progressive DCT), truncated, or
/// otherwise suspicious data. Conservative by design: `None` just means
/// "use the decode path", never an error.
fn parse_jpeg_frame(bytes: &[u8]) -> Option<JpegFrame> {
    if !is_jpeg_magic(bytes) || bytes.len() < 4 {
        return None;
    }
    let mut pos = 2;
    let mut adobe_transform: Option<u8> = None;
    while pos + 1 < bytes.len() {
        if bytes[pos] != 0xFF {
            return None;
        }
        // Skip fill bytes (0xFF padding before the marker code).
        let mut next = pos + 1;
        while next < bytes.len() && bytes[next] == 0xFF {
            next += 1;
        }
        if next >= bytes.len() {
            return None;
        }
        let marker = bytes[next];
        pos = next + 1;
        // Standalone markers carry no length.
        if marker == 0xD9 || marker == 0xDA {
            break; // EOI / SOS: no SOF found.
        }
        if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            continue;
        }
        if pos + 2 > bytes.len() {
            return None;
        }
        let seg_len = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
        if seg_len < 2 || pos + seg_len > bytes.len() {
            return None;
        }
        let body = &bytes[pos + 2..pos + seg_len];
        // Adobe APP14: "Adobe\0" + version(2) + flags(4) + transform(1).
        if marker == 0xEE && body.len() >= 13 && body[0..6] == *b"Adobe\x00" {
            adobe_transform = Some(body[12]);
        }
        if marker == 0xC0 || marker == 0xC1 {
            if body.len() < 6 {
                return None;
            }
            let height = u16::from_be_bytes([body[1], body[2]]) as u32;
            let width = u16::from_be_bytes([body[3], body[4]]) as u32;
            let components = body[5];
            if width == 0 || height == 0 || components == 0 {
                return None;
            }
            return Some(JpegFrame {
                width,
                height,
                components,
                adobe_transform,
            });
        }
        if marker == 0xC2 {
            return None; // Progressive DCT: viewers disagree; re-encode.
        }
        pos += seg_len;
    }
    None
}

// ---------------------------------------------------------------------------
// EXIF orientation
// ---------------------------------------------------------------------------

/// Reads EXIF orientation (1–8) from the original bytes. Returns 1 (normal)
/// when absent, unparseable, or out of range. Never fails the operation.
fn read_exif_orientation(bytes: &[u8]) -> u32 {
    let mut cursor = std::io::Cursor::new(bytes);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut cursor) else {
        return 1;
    };
    let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) else {
        return 1;
    };
    match field.value {
        exif::Value::Short(ref values) => {
            let first = values.first().copied().unwrap_or(1);
            let first = u32::from(first);
            if (1..=8).contains(&first) {
                first
            } else {
                1
            }
        }
        exif::Value::Long(ref values) => {
            let first = values.first().copied().unwrap_or(1);
            if (1..=8).contains(&first) {
                first
            } else {
                1
            }
        }
        _ => 1,
    }
}

/// Applies an EXIF orientation value to decoded pixels (values 1–8).
/// Dimensions swap for 5–8 (rotated). Pure pixel transform; input bytes
/// are untouched.
fn apply_exif_orientation(img: image::DynamicImage, orientation: u32) -> image::DynamicImage {
    match orientation {
        1 => img,
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        // 5 = transpose: flip horizontal, then rotate 270 CW.
        5 => img.fliph().rotate270(),
        6 => img.rotate90(),
        // 7 = transverse: flip horizontal, then rotate 90 CW.
        7 => img.fliph().rotate90(),
        8 => img.rotate270(),
        _ => img,
    }
}

// ---------------------------------------------------------------------------
// DPI detection
// ---------------------------------------------------------------------------

/// Detects DPI from EXIF → JFIF (JPEG) / pHYs (PNG), falling back to
/// [`DEFAULT_DPI`]. Returns `None` only when nothing valid was found (the
/// caller applies the fallback). Invalid values are ignored, never errors.
fn detect_dpi(bytes: &[u8]) -> Option<f64> {
    if let Some(dpi) = read_exif_dpi(bytes) {
        if valid_dpi(dpi) {
            return Some(dpi);
        }
    }
    if is_png_magic(bytes) {
        if let Some(dpi) = read_png_phys_dpi(bytes) {
            if valid_dpi(dpi) {
                return Some(dpi);
            }
        }
    } else if is_jpeg_magic(bytes) {
        if let Some(dpi) = read_jpeg_jfif_dpi(bytes) {
            if valid_dpi(dpi) {
                return Some(dpi);
            }
        }
    }
    None
}

fn valid_dpi(dpi: f64) -> bool {
    dpi.is_finite() && (MIN_DPI..=MAX_DPI).contains(&dpi)
}

/// Reads XResolution/YResolution + ResolutionUnit from EXIF.
fn read_exif_dpi(bytes: &[u8]) -> Option<f64> {
    let mut cursor = std::io::Cursor::new(bytes);
    let exif = exif::Reader::new().read_from_container(&mut cursor).ok()?;
    let x = exif.get_field(exif::Tag::XResolution, exif::In::PRIMARY)?;
    let unit = exif
        .get_field(exif::Tag::ResolutionUnit, exif::In::PRIMARY)
        .and_then(|field| match field.value {
            exif::Value::Short(ref values) => values.first().copied(),
            _ => None,
        })
        .unwrap_or(2);
    let dots = match &x.value {
        exif::Value::Rational(values) => {
            let rational = *values.first()?;
            if rational.denom == 0 {
                return None;
            }
            f64::from(rational.num) / f64::from(rational.denom)
        }
        exif::Value::Short(values) => f64::from(*values.first()?),
        _ => return None,
    };
    match unit {
        // 2 = inch (already DPI), 3 = centimeter → × 2.54.
        2 => Some(dots),
        3 => Some(dots * 2.54),
        _ => None,
    }
}

/// Reads the PNG `pHYs` chunk (pixels per meter → DPI).
fn read_png_phys_dpi(bytes: &[u8]) -> Option<f64> {
    if !is_png_magic(bytes) {
        return None;
    }
    let mut offset = 8usize;
    while offset + 8 <= bytes.len() {
        let length = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        let chunk_type = &bytes[offset + 4..offset + 8];
        let data_start = offset + 8;
        let data_end = data_start.checked_add(length)?;
        // +4 for CRC.
        let next = data_end.checked_add(4)?;
        if data_end > bytes.len() {
            return None;
        }
        if chunk_type == b"pHYs" && length == 9 {
            let ppux = u32::from_be_bytes([
                bytes[data_start],
                bytes[data_start + 1],
                bytes[data_start + 2],
                bytes[data_start + 3],
            ]);
            let unit = bytes[data_start + 8];
            // unit 1 = meter. 1 inch = 0.0254 m.
            if unit == 1 && ppux > 0 {
                return Some(f64::from(ppux) * 0.0254);
            }
            return None;
        }
        if chunk_type == b"IDAT" {
            // pHYs always precedes IDAT; stop scanning early.
            return None;
        }
        offset = next;
        if chunk_type == b"IEND" {
            break;
        }
    }
    None
}

/// Reads the JPEG JFIF APP0 density fields.
fn read_jpeg_jfif_dpi(bytes: &[u8]) -> Option<f64> {
    if !is_jpeg_magic(bytes) || bytes.len() < 4 {
        return None;
    }
    // SOI occupies bytes 0..2; segments start at 2.
    let mut offset = 2usize;
    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xFF {
            return None;
        }
        let marker = bytes[offset + 1];
        // Standalone markers without length.
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) || marker == 0x00 {
            offset += 2;
            continue;
        }
        if offset + 4 > bytes.len() {
            return None;
        }
        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
        if length < 2 || offset + 2 + length > bytes.len() {
            return None;
        }
        // APP0 with a JFIF header carries density.
        if marker == 0xE0 && length >= 16 {
            let base = offset + 4;
            if base + 14 <= bytes.len() && &bytes[base..base + 5] == b"JFIF\x00" {
                let units = bytes[base + 7];
                let xdensity = u16::from_be_bytes([bytes[base + 8], bytes[base + 9]]);
                match units {
                    1 => {
                        if xdensity > 0 {
                            return Some(f64::from(xdensity));
                        }
                    }
                    2 => {
                        if xdensity > 0 {
                            return Some(f64::from(xdensity) * 2.54);
                        }
                    }
                    _ => {}
                }
                return None;
            }
        }
        // Start of scan: no more headers worth reading.
        if marker == 0xDA {
            return None;
        }
        offset += 2 + length;
    }
    None
}

// ---------------------------------------------------------------------------
// PDF construction
// ---------------------------------------------------------------------------

/// Natural image size in points at its DPI.
fn natural_size_pt(image: &DecodedImage) -> (f64, f64) {
    let dpi = if valid_dpi(image.dpi) {
        image.dpi
    } else {
        DEFAULT_DPI
    };
    (
        round2(f64::from(image.width_px) * 72.0 / dpi),
        round2(f64::from(image.height_px) * 72.0 / dpi),
    )
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Incrementally-built PDF document: pages accumulate as objects, but
/// decoded image bytes are moved in and released per image — never
/// retained across pages.
struct PdfBuild {
    doc: lopdf::Document,
    pages_id: (u32, u16),
    kids: Vec<lopdf::Object>,
    // Test-only liveness accounting (P6): peak concurrently-live
    // decoded images within THIS builder. Per-instance (not global),
    // so parallel tests cannot interfere. Zero production impact.
    #[cfg(test)]
    live: usize,
    #[cfg(test)]
    peak_live: usize,
}

impl PdfBuild {
    fn begin(capacity: usize) -> Self {
        let mut doc = lopdf::Document::with_version("1.4");
        let pages_id = doc.new_object_id();
        Self {
            doc,
            pages_id,
            kids: Vec::with_capacity(capacity),
            #[cfg(test)]
            live: 0,
            #[cfg(test)]
            peak_live: 0,
        }
    }

    #[cfg(test)]
    fn peak_live(&self) -> usize {
        self.peak_live
    }

    #[cfg(test)]
    fn track_live(&mut self) {
        self.live += 1;
        self.peak_live = self.peak_live.max(self.live);
    }

    #[cfg(test)]
    fn untrack_live(&mut self) {
        self.live = self.live.saturating_sub(1);
    }

    /// Embeds one decoded image as the next page, taking ownership of
    /// its payload (no clone — the caller's copy is moved from).
    /// The bytes are released when this call returns: peak retention
    /// across a run is one image.
    fn append(&mut self, decoded: DecodedImage, policy: PageSizePolicy) -> Result<(), EngineError> {
        #[cfg(test)]
        self.track_live();
        let (page_w, page_h, rect) = placement(&decoded, policy);
        if !(page_w.is_finite() && page_h.is_finite() && page_w > 0.0 && page_h > 0.0) {
            return Err(EngineError::new(
                ErrorCode::Internal,
                "computed page dimensions are invalid",
            ));
        }

        let image_id = self.doc.new_object_id();
        let image_dict = match &decoded.payload {
            ImagePayload::RawRgb(_) => dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => i64::from(decoded.width_px),
                "Height" => i64::from(decoded.height_px),
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
            },
            ImagePayload::Jpeg(payload) => {
                let mut dict = dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => i64::from(decoded.width_px),
                    "Height" => i64::from(decoded.height_px),
                    "ColorSpace" => payload.color_space.pdf_name(),
                    "BitsPerComponent" => 8,
                    "Filter" => "DCTDecode",
                };
                // Adobe inverted CMYK stores 0 as ink: invert on render.
                if payload.color_space == JpegColorSpace::Cmyk {
                    dict.set(
                        "Decode",
                        vec![
                            lopdf::Object::Integer(1),
                            lopdf::Object::Integer(0),
                            lopdf::Object::Integer(1),
                            lopdf::Object::Integer(0),
                            lopdf::Object::Integer(1),
                            lopdf::Object::Integer(0),
                            lopdf::Object::Integer(1),
                            lopdf::Object::Integer(0),
                        ],
                    );
                }
                dict
            }
        };
        // Moved in, not cloned: the decoded buffer now belongs to the
        // document (the caller's copy is gone after this call).
        let content = match decoded.payload {
            ImagePayload::RawRgb(rgb) => rgb,
            ImagePayload::Jpeg(payload) => payload.bytes,
        };
        self.doc.objects.insert(
            image_id,
            lopdf::Object::Stream(Stream::new(image_dict, content)),
        );
        #[cfg(test)]
        self.untrack_live();

        let (draw_w, draw_h, draw_x, draw_y) = rect;
        let content = format!(
            "q {:.2} 0 0 {:.2} {:.2} {:.2} cm /Im1 Do Q",
            draw_w, draw_h, draw_x, draw_y
        );
        let content_id = self.doc.new_object_id();
        self.doc.objects.insert(
            content_id,
            lopdf::Object::Stream(Stream::new(dictionary! {}, content.into_bytes())),
        );

        let page_id = self.doc.new_object_id();
        let page_dict = dictionary! {
            "Type" => "Page",
            "Parent" => self.pages_id,
            "MediaBox" => vec![
                lopdf::Object::Integer(0),
                lopdf::Object::Integer(0),
                lopdf::Object::Real(page_w as f32),
                lopdf::Object::Real(page_h as f32),
            ],
            "Resources" => dictionary! {
                "XObject" => dictionary! {
                    "Im1" => image_id,
                },
            },
            "Contents" => content_id,
        };
        self.doc
            .objects
            .insert(page_id, lopdf::Object::Dictionary(page_dict));
        self.kids.push(lopdf::Object::Reference(page_id));
        Ok(())
    }

    /// Finalizes the document: Pages tree, catalog, trailer. Called once
    /// after every image embedded — outputs exist only on success, so a
    /// mid-run failure still yields no partial PDF (atomic).
    fn finish(self) -> PdfDocument {
        let count = self.kids.len() as i64;
        let mut doc = self.doc;
        doc.objects.insert(
            self.pages_id,
            lopdf::Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => lopdf::Object::Array(self.kids),
                "Count" => count,
            }),
        );
        let catalog_id = doc.new_object_id();
        doc.objects.insert(
            catalog_id,
            lopdf::Object::Dictionary(dictionary! {
                "Type" => "Catalog",
                "Pages" => self.pages_id,
            }),
        );
        doc.trailer.set("Root", catalog_id);
        // Fixed producer only (no timestamps): output stays byte-deterministic.
        let info_id = doc.new_object_id();
        doc.objects.insert(
            info_id,
            lopdf::Object::Dictionary(dictionary! {
                "Producer" => lopdf::Object::string_literal("folio-engine images_to_pdf"),
            }),
        );
        doc.trailer.set("Info", info_id);

        PdfDocument::from_lopdf(doc)
    }
}

/// Returns `(page_w, page_h, (draw_w, draw_h, draw_x, draw_y))` in points.
fn placement(image: &DecodedImage, policy: PageSizePolicy) -> (f64, f64, (f64, f64, f64, f64)) {
    let (natural_w, natural_h) = natural_size_pt(image);
    match policy {
        PageSizePolicy::FitImage => (natural_w, natural_h, (natural_w, natural_h, 0.0, 0.0)),
        PageSizePolicy::StandardPage => {
            let scale = (A4_WIDTH_PT / natural_w).min(A4_HEIGHT_PT / natural_h);
            let draw_w = round2(natural_w * scale);
            let draw_h = round2(natural_h * scale);
            let draw_x = round2((A4_WIDTH_PT - draw_w) / 2.0);
            let draw_y = round2((A4_HEIGHT_PT - draw_h) / 2.0);
            (A4_WIDTH_PT, A4_HEIGHT_PT, (draw_w, draw_h, draw_x, draw_y))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::operation::OperationContext;
    use crate::execution::job::JobId;
    use crate::processing::pdf::core::loader::load_pdf;

    struct NullCtx {
        id: JobId,
    }

    impl OperationContext for NullCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.images_to_pdf"
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

    struct RecordingCtx {
        id: JobId,
        events: std::cell::RefCell<Vec<u64>>,
    }

    impl OperationContext for RecordingCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.images_to_pdf"
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

    struct CancelAfterCtx {
        id: JobId,
        remaining: std::cell::Cell<usize>,
        max_completed: std::cell::Cell<u64>,
    }

    impl OperationContext for CancelAfterCtx {
        fn job_id(&self) -> &JobId {
            &self.id
        }
        fn operation_name(&self) -> &str {
            "pdf.images_to_pdf"
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
                return Err(EngineError::cancelled(&self.id, "pdf.images_to_pdf"));
            }
            self.remaining.set(left - 1);
            Ok(())
        }
    }

    fn ctx() -> NullCtx {
        NullCtx { id: JobId::new() }
    }

    fn opts() -> ImagesToPdfOptions {
        ImagesToPdfOptions::default()
    }

    // -- deterministic image fixtures (generated, no binaries) ---------------

    fn solid_rgb_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        use image::ImageEncoder;
        let mut img = image::RgbImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgb(rgb);
        }
        let mut bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .expect("png encodes");
        bytes
    }

    fn solid_rgba_png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        use image::ImageEncoder;
        let mut img = image::RgbaImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgba(rgba);
        }
        let mut bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgba8)
            .expect("png encodes");
        bytes
    }

    fn transparent_center_png() -> Vec<u8> {
        use image::ImageEncoder;
        // 4x4 opaque red with a 2x2 fully transparent center.
        let mut img = image::RgbaImage::new(4, 4);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            if (1..3).contains(&x) && (1..3).contains(&y) {
                *pixel = image::Rgba([0, 0, 0, 0]);
            } else {
                *pixel = image::Rgba([255, 0, 0, 255]);
            }
        }
        let mut bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder
            .write_image(img.as_raw(), 4, 4, image::ExtendedColorType::Rgba8)
            .expect("png encodes");
        bytes
    }

    fn gray_png(width: u32, height: u32, luma: u8) -> Vec<u8> {
        use image::ImageEncoder;
        let mut img = image::GrayImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = image::Luma([luma]);
        }
        let mut bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::L8)
            .expect("png encodes");
        bytes
    }

    fn solid_jpeg(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        use image::ImageEncoder;
        let mut img = image::RgbImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgb(rgb);
        }
        let mut bytes = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90);
        encoder
            .write_image(img.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .expect("jpeg encodes");
        bytes
    }

    /// Injects a minimal EXIF APP1 segment carrying only an Orientation tag.
    fn inject_exif_orientation(jpeg: &[u8], orientation: u16) -> Vec<u8> {
        assert!(jpeg.len() >= 2 && jpeg[0] == 0xFF && jpeg[1] == 0xD8);
        let lo = (orientation & 0xFF) as u8;
        let hi = (orientation >> 8) as u8;
        let mut tiff = Vec::with_capacity(26);
        // Little-endian TIFF header.
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&[0x2A, 0x00]);
        tiff.extend_from_slice(&[0x08, 0x00, 0x00, 0x00]);
        // IFD0: 1 entry.
        tiff.extend_from_slice(&[0x01, 0x00]);
        // Tag 0x0112 (Orientation), type SHORT (3), count 1, inline value.
        tiff.extend_from_slice(&[0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00]);
        tiff.extend_from_slice(&[lo, hi, 0x00, 0x00]);
        // Next IFD offset = 0.
        tiff.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        let mut out = Vec::with_capacity(jpeg.len() + 40);
        out.extend_from_slice(&jpeg[0..2]);
        let seg_len = (2 + 6 + tiff.len()) as u16;
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&seg_len.to_be_bytes());
        out.extend_from_slice(b"Exif\x00\x00");
        out.extend_from_slice(&tiff);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    fn input_named(name: &str, bytes: Vec<u8>) -> ImagesToPdfInput {
        ImagesToPdfInput::new(vec![ImageInput::new(name, bytes).expect("input builds")])
    }

    fn input_many(entries: Vec<(&str, Vec<u8>)>) -> ImagesToPdfInput {
        ImagesToPdfInput::new(
            entries
                .into_iter()
                .map(|(name, bytes)| ImageInput::new(name, bytes).expect("input builds"))
                .collect(),
        )
    }

    fn run_and_reparse(input: ImagesToPdfInput, options: ImagesToPdfOptions) -> PdfDocument {
        let mut out = ImagesToPdfOperation
            .execute(&ctx(), input, options)
            .expect("images_to_pdf succeeds")
            .document;
        let bytes = out.save_to_bytes().expect("output serializes");
        load_pdf(&bytes).expect("output re-parses")
    }

    /// Extracts embedded image payloads directly from serialized output
    /// bytes, in page order.
    fn output_images_from_bytes(bytes: &[u8]) -> Vec<(u32, u32, Vec<u8>)> {
        let raw = lopdf::Document::load_mem(bytes).expect("output parses");
        let pages = raw.get_pages();
        let mut numbers: Vec<u32> = pages.keys().copied().collect();
        numbers.sort_unstable();
        let mut out = Vec::new();
        for number in numbers {
            let page_id = pages[&number];
            let page = raw.get_dictionary(page_id).expect("page dict");
            let resources = page.get(b"Resources").expect("resources");
            let (_, resources) = raw.dereference(resources).expect("resources resolve");
            let xobjects = resources
                .as_dict()
                .expect("dict")
                .get(b"XObject")
                .expect("xobject");
            let (_, xobjects) = raw.dereference(xobjects).expect("resolve");
            let im = xobjects.as_dict().expect("dict").get(b"Im1").expect("Im1");
            let (_, image) = raw.dereference(im).expect("image resolves");
            let stream = image.as_stream().expect("image stream");
            let width = stream
                .dict
                .get(b"Width")
                .expect("width")
                .as_i64()
                .expect("int") as u32;
            let height = stream
                .dict
                .get(b"Height")
                .expect("height")
                .as_i64()
                .expect("int") as u32;
            out.push((width, height, stream.content.clone()));
        }
        out
    }

    fn run_bytes(input: ImagesToPdfInput, options: ImagesToPdfOptions) -> Vec<u8> {
        let mut out = ImagesToPdfOperation
            .execute(&ctx(), input, options)
            .expect("succeeds")
            .document;
        out.save_to_bytes().expect("serializes")
    }

    // -- basic ---------------------------------------------------------------

    #[test]
    fn operation_name_follows_pdf_convention() {
        assert_eq!(ImagesToPdfOperation.name(), "pdf.images_to_pdf");
    }

    #[test]
    fn single_jpeg_produces_single_page() {
        let bytes = solid_jpeg(16, 12, [200, 30, 30]);
        let reparsed = run_and_reparse(input_named("photo.jpg", bytes), opts());
        assert_eq!(reparsed.page_count(), 1);
        let geometry = reparsed.page_geometry(1).expect("geometry");
        // Fallback DPI 150 → 16px = 7.68pt, 12px = 5.76pt.
        assert!(
            (geometry.width_pt - 7.68).abs() < 0.05,
            "{}",
            geometry.width_pt
        );
        assert!(
            (geometry.height_pt - 5.76).abs() < 0.05,
            "{}",
            geometry.height_pt
        );
    }

    #[test]
    fn single_png_produces_single_page() {
        let bytes = solid_rgb_png(12, 16, [30, 120, 200]);
        let reparsed = run_and_reparse(input_named("graphic.png", bytes), opts());
        assert_eq!(reparsed.page_count(), 1);
        let geometry = reparsed.page_geometry(1).expect("geometry");
        assert!(
            geometry.width_pt < geometry.height_pt,
            "portrait stays portrait"
        );
    }

    #[test]
    fn multiple_images_produce_multiple_pages_in_order() {
        let red = solid_rgb_png(8, 8, [255, 0, 0]);
        let green = solid_rgb_png(8, 8, [0, 255, 0]);
        let blue = solid_rgb_png(8, 8, [0, 0, 255]);
        let bytes = run_bytes(
            input_many(vec![("a.png", red), ("b.png", green), ("c.png", blue)]),
            opts(),
        );
        let reparsed = load_pdf(&bytes).expect("re-parses");
        assert_eq!(reparsed.page_count(), 3);
        let images = output_images_from_bytes(&bytes);
        assert_eq!(images.len(), 3);
        // Raw RGB payloads preserve input order: first pixel per page.
        assert_eq!(&images[0].2[0..3], &[255, 0, 0]);
        assert_eq!(&images[1].2[0..3], &[0, 255, 0]);
        assert_eq!(&images[2].2[0..3], &[0, 0, 255]);
    }

    // -- incremental memory (P6 regression) ------------------------------------

    #[test]
    fn peak_decoded_retention_is_one_image_not_n() {
        // The execute loop must embed each image and release it before
        // decoding the next: at 12 MP scale, N retained RGB buffers is
        // the browser-crash architecture. `PdfBuild` counts live decoded
        // images per builder instance (no globals — parallel tests cannot
        // interfere); the execute loop holds no other decoded storage,
        // so builder peak == run peak.
        let mut pdf = PdfBuild::begin(5);
        for (i, color) in [
            [200, 30, 30],
            [30, 200, 30],
            [30, 30, 200],
            [200, 200, 30],
            [30, 200, 200],
        ]
        .iter()
        .enumerate()
        {
            let bytes = solid_rgb_png(32, 32, *color);
            let image = ImageInput::new(format!("{i}.png"), bytes).expect("input builds");
            let item = decode_image(&image, i, [255, 255, 255]).expect("decodes");
            pdf.append(item, PageSizePolicy::FitImage).expect("embeds");
        }
        assert_eq!(
            pdf.peak_live(),
            1,
            "peak decoded retention must be one image"
        );
        let mut doc = pdf.finish();
        let bytes = doc.save_to_bytes().expect("serializes");
        let reparsed = load_pdf(&bytes).expect("re-parses");
        assert_eq!(reparsed.page_count(), 5);
    }

    // -- dimensions / aspect ---------------------------------------------------

    #[test]
    fn portrait_landscape_square_and_mixed() {
        let portrait = solid_rgb_png(8, 16, [10, 10, 10]);
        let landscape = solid_jpeg(16, 8, [10, 10, 10]);
        let square = solid_rgb_png(12, 12, [10, 10, 10]);
        let bytes = run_bytes(
            input_many(vec![
                ("portrait.png", portrait),
                ("landscape.jpg", landscape),
                ("square.png", square),
            ]),
            opts(),
        );
        let reparsed = load_pdf(&bytes).expect("re-parses");
        assert_eq!(reparsed.page_count(), 3);
        let portrait_geo = reparsed.page_geometry(1).expect("p1");
        let landscape_geo = reparsed.page_geometry(2).expect("p2");
        let square_geo = reparsed.page_geometry(3).expect("p3");
        assert!(portrait_geo.height_pt > portrait_geo.width_pt);
        assert!(landscape_geo.width_pt > landscape_geo.height_pt);
        assert!((square_geo.width_pt - square_geo.height_pt).abs() < 0.01);
    }

    #[test]
    fn aspect_ratio_preserved_on_standard_page() {
        // 16x8 (2:1) on A4: drawn rect must stay 2:1 and fit inside A4.
        let bytes = solid_rgb_png(16, 8, [90, 90, 90]);
        let serialized = run_bytes(
            input_named("wide.png", bytes),
            ImagesToPdfOptions::new(PageSizePolicy::StandardPage, [255, 255, 255]),
        );
        let reparsed = load_pdf(&serialized).expect("re-parses");
        let geometry = reparsed.page_geometry(1).expect("geometry");
        assert!((geometry.width_pt - A4_WIDTH_PT).abs() < 0.05);
        assert!((geometry.height_pt - A4_HEIGHT_PT).abs() < 0.05);
        // Parse the content stream matrix: q w 0 0 h x y cm /Im1 Do Q.
        let raw = lopdf::Document::load_mem(&serialized).expect("parses");
        let page_id = raw.get_pages()[&1];
        let content_id = raw
            .get_dictionary(page_id)
            .expect("page")
            .get(b"Contents")
            .expect("contents")
            .as_reference()
            .expect("ref");
        let content = raw
            .get_object(content_id)
            .expect("obj")
            .as_stream()
            .expect("stream");
        let text = String::from_utf8_lossy(&content.content);
        let first: Vec<f64> = text
            .split_whitespace()
            .filter_map(|token| token.parse::<f64>().ok())
            .take(6)
            .collect();
        // q w 0 0 h x y cm → tokens [w, 0, 0, h, x, y].
        assert_eq!(first.len(), 6, "matrix parses: {text}");
        let (draw_w, draw_h) = (first[0], first[3]);
        let image_aspect = 16.0 / 8.0;
        let drawn_aspect = draw_w / draw_h;
        assert!(
            (drawn_aspect - image_aspect).abs() < 0.02,
            "drawn {draw_w}x{draw_h} preserves 2:1"
        );
        assert!(draw_w <= A4_WIDTH_PT + 0.01 && draw_h <= A4_HEIGHT_PT + 0.01);
        // Centered: non-zero offsets on the constrained axis.
        assert!(first[4] >= 0.0 && first[5] >= 0.0);
    }

    #[test]
    fn standard_page_uses_a4_dimensions() {
        let bytes = solid_rgb_png(10, 10, [1, 2, 3]);
        let reparsed = run_and_reparse(
            input_named("square.png", bytes),
            ImagesToPdfOptions::new(PageSizePolicy::StandardPage, [255, 255, 255]),
        );
        let geometry = reparsed.page_geometry(1).expect("geometry");
        assert!((geometry.width_pt - A4_WIDTH_PT).abs() < 0.05);
        assert!((geometry.height_pt - A4_HEIGHT_PT).abs() < 0.05);
    }

    // -- PNG variants ------------------------------------------------------------

    #[test]
    fn rgb_png_round_trips_exact_colors() {
        let bytes = solid_rgb_png(4, 4, [10, 200, 30]);
        let serialized = run_bytes(input_named("rgb.png", bytes), opts());
        let images = output_images_from_bytes(&serialized);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].0, 4);
        assert_eq!(images[0].1, 4);
        assert!(images[0].2.chunks_exact(3).all(|px| px == [10, 200, 30]));
    }

    #[test]
    fn opaque_rgba_matches_rgb() {
        let bytes = solid_rgba_png(4, 4, [10, 20, 30, 255]);
        let serialized = run_bytes(input_named("opaque.png", bytes), opts());
        let images = output_images_from_bytes(&serialized);
        assert!(images[0].2.chunks_exact(3).all(|px| px == [10, 20, 30]));
    }

    #[test]
    fn transparent_pixels_composite_against_white() {
        let bytes = transparent_center_png();
        let serialized = run_bytes(input_named("alpha.png", bytes), opts());
        let images = output_images_from_bytes(&serialized);
        assert_eq!((images[0].0, images[0].1), (4, 4));
        let row = |x: u32, y: u32| {
            let offset = ((y * 4 + x) * 3) as usize;
            [
                images[0].2[offset],
                images[0].2[offset + 1],
                images[0].2[offset + 2],
            ]
        };
        assert_eq!(row(0, 0), [255, 0, 0]);
        // Transparent center becomes the white background, never black.
        assert_eq!(row(1, 1), [255, 255, 255]);
        assert_eq!(row(2, 2), [255, 255, 255]);
    }

    #[test]
    fn grayscale_png_expands_to_rgb() {
        let bytes = gray_png(4, 4, 128);
        let serialized = run_bytes(input_named("gray.png", bytes), opts());
        let images = output_images_from_bytes(&serialized);
        assert!(images[0].2.chunks_exact(3).all(|px| px == [128, 128, 128]));
    }

    // -- JPEG ---------------------------------------------------------------------

    #[test]
    fn large_jpeg_succeeds() {
        let bytes = solid_jpeg(320, 240, [40, 80, 160]);
        let reparsed = run_and_reparse(input_named("large.jpg", bytes), opts());
        assert_eq!(reparsed.page_count(), 1);
        let images = output_images_from_bytes(&run_bytes(
            input_named("large.jpg", solid_jpeg(320, 240, [40, 80, 160])),
            opts(),
        ));
        assert_eq!((images[0].0, images[0].1), (320, 240));
    }

    #[test]
    fn exif_orientation_6_swaps_dimensions() {
        // 12x8 landscape pixels tagged orientation 6 (rotate 90 CW) must
        // present as 8x12 portrait.
        let base = solid_jpeg(12, 8, [180, 40, 40]);
        assert_eq!(read_exif_orientation(&base), 1);
        let tagged = inject_exif_orientation(&base, 6);
        assert_eq!(read_exif_orientation(&tagged), 6);
        let serialized = run_bytes(input_named("exif.jpg", tagged), opts());
        let images = output_images_from_bytes(&serialized);
        assert_eq!((images[0].0, images[0].1), (8, 12));
        let reparsed = load_pdf(&serialized).expect("re-parses");
        let geometry = reparsed.page_geometry(1).expect("geometry");
        assert!(
            geometry.height_pt > geometry.width_pt,
            "EXIF-rotated page is portrait"
        );
    }

    #[test]
    fn exif_orientation_3_keeps_dimensions() {
        let base = solid_jpeg(12, 8, [40, 180, 40]);
        let tagged = inject_exif_orientation(&base, 3);
        assert_eq!(read_exif_orientation(&tagged), 3);
        let serialized = run_bytes(input_named("exif3.jpg", tagged), opts());
        let images = output_images_from_bytes(&serialized);
        assert_eq!((images[0].0, images[0].1), (12, 8));
    }

    // -- JPEG passthrough ----------------------------------------------------------

    /// Filter + ColorSpace + raw content per embedded image page.
    fn image_stream_info(serialized: &[u8]) -> Vec<(Option<String>, Option<String>, Vec<u8>)> {
        let raw = lopdf::Document::load_mem(serialized).expect("parses");
        let mut numbers: Vec<u32> = raw.get_pages().keys().copied().collect();
        numbers.sort_unstable();
        let mut out = Vec::new();
        for number in numbers {
            let page_id = raw.get_pages()[&number];
            let page = raw.get_dictionary(page_id).expect("page dict");
            let resources = page.get(b"Resources").expect("resources");
            let (_, resources) = raw.dereference(resources).expect("resolve");
            let xobjects = resources
                .as_dict()
                .expect("dict")
                .get(b"XObject")
                .expect("xobject");
            let (_, xobjects) = raw.dereference(xobjects).expect("resolve");
            let im = xobjects.as_dict().expect("dict").get(b"Im1").expect("Im1");
            let (_, image) = raw.dereference(im).expect("image resolves");
            let stream = image.as_stream().expect("stream");
            let name = |key: &[u8]| {
                stream
                    .dict
                    .get(key)
                    .ok()
                    .and_then(|o| o.as_name().ok())
                    .map(|n| String::from_utf8_lossy(n).into_owned())
            };
            out.push((name(b"Filter"), name(b"ColorSpace"), stream.content.clone()));
        }
        out
    }

    #[test]
    fn baseline_jpeg_passes_through_untouched() {
        let input = solid_jpeg(64, 48, [200, 30, 30]);
        let item = decode_image(
            &ImageInput::new("photo.jpg", input.clone()).expect("input builds"),
            0,
            [255, 255, 255],
        )
        .expect("decodes");
        assert_eq!((item.width_px, item.height_px), (64, 48));
        match item.payload {
            ImagePayload::Jpeg(payload) => {
                assert_eq!(payload.bytes, input, "passthrough is byte-identical");
                assert_eq!(payload.color_space, JpegColorSpace::Rgb);
            }
            ImagePayload::RawRgb(_) => panic!("baseline JPEG must pass through, not decode"),
        }
    }

    #[test]
    fn passthrough_pdf_embeds_dct_and_stays_small() {
        let input = solid_jpeg(320, 240, [40, 80, 160]);
        let raw_budget = 320usize * 240 * 3;
        assert!(input.len() < raw_budget / 4, "fixture sanity");
        let serialized = run_bytes(input_named("photo.jpg", input.clone()), opts());
        let info = image_stream_info(&serialized);
        assert_eq!(info.len(), 1);
        assert_eq!(info[0].0.as_deref(), Some("DCTDecode"));
        assert_eq!(info[0].1.as_deref(), Some("DeviceRGB"));
        assert_eq!(info[0].2, input, "embedded stream is the original file");
        assert!(
            serialized.len() < raw_budget,
            "PDF stays far below raw RGB: {} vs {raw_budget}",
            serialized.len()
        );
    }

    #[test]
    fn exif_rotated_jpeg_falls_back_to_reencode() {
        // Orientation 6 cannot pass through (SOF dims ≠ presented dims):
        // pixels rotate, then a single q82 re-encode bounds the size.
        let base = solid_jpeg(64, 48, [180, 40, 40]);
        let tagged = inject_exif_orientation(&base, 6);
        let item = decode_image(
            &ImageInput::new("exif.jpg", tagged.clone()).expect("input builds"),
            0,
            [255, 255, 255],
        )
        .expect("decodes");
        assert_eq!((item.width_px, item.height_px), (48, 64));
        match item.payload {
            ImagePayload::Jpeg(payload) => {
                assert_ne!(payload.bytes, tagged, "fallback re-encodes, never copies");
                assert_eq!(payload.color_space, JpegColorSpace::Rgb);
                // Still DCT in the PDF and far below raw RGB.
                let serialized = run_bytes(input_named("exif.jpg", tagged), opts());
                let info = image_stream_info(&serialized);
                assert_eq!(info[0].0.as_deref(), Some("DCTDecode"));
                assert!(
                    info[0].2.len() < 48 * 64 * 3,
                    "fallback stays far below raw RGB: {}",
                    info[0].2.len()
                );
            }
            ImagePayload::RawRgb(_) => panic!("fallback must re-encode to JPEG"),
        }
    }

    #[test]
    fn frame_parser_reads_baseline_sof() {
        let bytes = solid_jpeg(64, 48, [1, 2, 3]);
        let frame = parse_jpeg_frame(&bytes).expect("parses");
        assert_eq!((frame.width, frame.height), (64, 48));
        assert_eq!(frame.components, 3);
        assert_eq!(frame.adobe_transform, None);
        assert_eq!(jpeg_color_space(&frame), Some(JpegColorSpace::Rgb));
    }

    #[test]
    fn frame_parser_rejects_progressive_sof2() {
        // SOI + minimal APP0 + SOF2 (progressive): well-formed enough to
        // parse, but passthrough must refuse (viewers disagree on
        // progressive DCT).
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        bytes.extend_from_slice(b"JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x00\x00");
        bytes.extend_from_slice(&[0xFF, 0xC2, 0x00, 0x0B, 0x08]);
        bytes.extend_from_slice(&[0x00, 0x30, 0x00, 0x20, 0x03]);
        bytes.extend_from_slice(&[0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(parse_jpeg_frame(&bytes), None);
    }

    #[test]
    fn frame_parser_reads_adobe_cmyk() {
        // SOI + APP14 (transform 0) + SOF0 with 4 components.
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xEE, 0x00, 0x0F];
        bytes.extend_from_slice(b"Adobe\x00\x01\x00\x00\x00\x00\x00\x00");
        bytes.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0E, 0x08]);
        bytes.extend_from_slice(&[0x00, 0x10, 0x00, 0x10, 0x04]);
        bytes.extend_from_slice(&[0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        let frame = parse_jpeg_frame(&bytes).expect("parses");
        assert_eq!(frame.components, 4);
        assert_eq!(frame.adobe_transform, Some(0));
        assert_eq!(jpeg_color_space(&frame), Some(JpegColorSpace::Cmyk));
    }

    #[test]
    fn frame_parser_rejects_truncated_and_foreign_data() {
        assert_eq!(parse_jpeg_frame(&[]), None);
        assert_eq!(parse_jpeg_frame(b"not a jpeg"), None);
        let mut bytes = solid_jpeg(16, 16, [1, 2, 3]);
        bytes.truncate(24);
        assert_eq!(parse_jpeg_frame(&bytes), None);
    }

    #[test]
    fn input_bytes_are_never_mutated() {
        let bytes = solid_rgb_png(8, 8, [9, 9, 9]);
        let before = bytes.clone();
        ImagesToPdfOperation
            .execute(&ctx(), input_named("a.png", bytes.clone()), opts())
            .expect("succeeds");
        assert_eq!(bytes, before);
    }

    // -- DPI -------------------------------------------------------------------------

    #[test]
    fn fallback_dpi_applies_without_metadata() {
        // Generated fixtures carry no DPI → DEFAULT_DPI.
        assert_eq!(detect_dpi(&solid_rgb_png(8, 8, [1, 2, 3])), None);
        assert_eq!(detect_dpi(&solid_jpeg(8, 8, [1, 2, 3])), None);
        let bytes = solid_rgb_png(150, 150, [5, 5, 5]);
        let reparsed = run_and_reparse(input_named("dpi.png", bytes), opts());
        let geometry = reparsed.page_geometry(1).expect("geometry");
        // 150px at 150 DPI = 72pt.
        assert!(
            (geometry.width_pt - 72.0).abs() < 0.05,
            "{}",
            geometry.width_pt
        );
    }

    #[test]
    fn png_phys_dpi_parses() {
        // Signature + pHYs (10000 px/m ≈ 254 DPI) + minimal tail.
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10];
        let ppux = 10_000u32;
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&9u32.to_be_bytes());
        chunk.extend_from_slice(b"pHYs");
        chunk.extend_from_slice(&ppux.to_be_bytes());
        chunk.extend_from_slice(&ppux.to_be_bytes());
        chunk.push(1);
        chunk.extend_from_slice(&[0, 0, 0, 0]); // CRC (ignored)
        bytes.extend_from_slice(&chunk);
        let dpi = read_png_phys_dpi(&bytes).expect("parses");
        assert!((dpi - 254.0).abs() < 0.01, "{dpi}");
    }

    #[test]
    fn jpeg_jfif_dpi_parses() {
        // SOI + APP0 JFIF units=1 Xdensity=300.
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        bytes.extend_from_slice(b"JFIF\x00\x01\x02\x01");
        bytes.extend_from_slice(&300u16.to_be_bytes());
        bytes.extend_from_slice(&300u16.to_be_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(read_jpeg_jfif_dpi(&bytes), Some(300.0));
    }

    // -- errors -------------------------------------------------------------------------

    #[test]
    fn rejects_zero_images() {
        let err = ImagesToPdfOperation
            .execute(&ctx(), ImagesToPdfInput::new(vec![]), opts())
            .expect_err("empty must fail");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
    }

    #[test]
    fn rejects_malformed_bytes_with_index_and_name() {
        let err = ImagesToPdfOperation
            .execute(
                &ctx(),
                input_named("not-an-image.png", b"definitely not an image".to_vec()),
                opts(),
            )
            .expect_err("malformed must fail");
        assert_eq!(err.code(), ErrorCode::UnsupportedFormat);
        assert!(err.message().contains("1"), "{}", err.message());
        assert!(
            err.message().contains("not-an-image.png"),
            "{}",
            err.message()
        );
        let details = err.details().expect("details");
        assert!(details.contains("image_index=1"), "{details}");
        assert!(details.contains("not-an-image.png"), "{details}");
    }

    #[test]
    fn corrupt_jpeg_reports_invalid_document() {
        // Valid JPEG magic but truncated content.
        let mut bytes = solid_jpeg(16, 16, [10, 10, 10]);
        bytes.truncate(bytes.len() / 3);
        let err = ImagesToPdfOperation
            .execute(&ctx(), input_named("broken.jpg", bytes), opts())
            .expect_err("corrupt must fail");
        // Either invalid-document (decode failed) or unsupported (header
        // probe failed) is acceptable; both carry index + name.
        assert!(
            err.code() == ErrorCode::InvalidDocument || err.code() == ErrorCode::UnsupportedFormat,
            "unexpected code {:?}",
            err.code()
        );
        let details = err.details().expect("details");
        assert!(details.contains("image_index=1"), "{details}");
    }

    #[test]
    fn per_image_error_identifies_failing_entry() {
        let good = solid_rgb_png(8, 8, [1, 2, 3]);
        let bad = b"nope".to_vec();
        let err = ImagesToPdfOperation
            .execute(
                &ctx(),
                input_many(vec![
                    ("first.png", good.clone()),
                    ("second.png", good),
                    ("third.png", bad),
                ]),
                opts(),
            )
            .expect_err("third must fail");
        let details = err.details().expect("details");
        assert!(details.contains("image_index=3"), "{details}");
        assert!(details.contains("third.png"), "{details}");
    }

    #[test]
    fn failure_is_atomic_no_partial_pdf() {
        let good = solid_rgb_png(8, 8, [1, 2, 3]);
        let result = ImagesToPdfOperation.execute(
            &ctx(),
            input_many(vec![("ok.png", good), ("bad.png", b"bad".to_vec())]),
            opts(),
        );
        assert!(result.is_err(), "must be Err, never a partial PDF");
    }

    #[test]
    fn rejects_empty_bytes_at_construction() {
        assert!(ImageInput::new("empty.png", Vec::new()).is_err());
    }

    // -- cancellation / progress --------------------------------------------------------------

    #[test]
    fn cancellation_aborts_before_construction() {
        let cancelled = CancelAfterCtx {
            id: JobId::new(),
            remaining: std::cell::Cell::new(0),
            max_completed: std::cell::Cell::new(0),
        };
        let err = ImagesToPdfOperation
            .execute(
                &cancelled,
                input_named("a.png", solid_rgb_png(8, 8, [1, 2, 3])),
                opts(),
            )
            .expect_err("cancelled must fail");
        assert_eq!(err.code(), ErrorCode::Cancelled);
    }

    #[test]
    fn cancellation_mid_run_reports_no_completion() {
        let images: Vec<(&str, Vec<u8>)> = (0..6)
            .map(|i| {
                (
                    match i {
                        0 => "a.png",
                        1 => "b.png",
                        2 => "c.png",
                        3 => "d.png",
                        4 => "e.png",
                        _ => "f.png",
                    },
                    solid_rgb_png(32, 32, [10, 20, 30]),
                )
            })
            .collect();
        // Two checks pass (validating, preparing); the third — inside image
        // processing — fails.
        let ctx = CancelAfterCtx {
            id: JobId::new(),
            remaining: std::cell::Cell::new(2),
            max_completed: std::cell::Cell::new(0),
        };
        let err = ImagesToPdfOperation
            .execute(&ctx, input_many(images), opts())
            .expect_err("mid-run cancel must fail");
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
        ImagesToPdfOperation
            .execute(
                &ctx,
                input_many(vec![
                    ("a.png", solid_rgb_png(8, 8, [1, 1, 1])),
                    ("b.jpg", solid_jpeg(8, 8, [2, 2, 2])),
                ]),
                opts(),
            )
            .expect("succeeds");
        let events = ctx.events.borrow();
        assert!(!events.is_empty());
        assert!(
            events.windows(2).all(|pair| pair[0] <= pair[1]),
            "{events:?}"
        );
        assert_eq!(*events.last().expect("events"), 100);
    }

    #[test]
    fn output_is_deterministic() {
        let run = || {
            run_bytes(
                input_many(vec![
                    ("a.png", solid_rgb_png(8, 8, [9, 8, 7])),
                    ("b.jpg", solid_jpeg(8, 8, [7, 8, 9])),
                ]),
                opts(),
            )
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn page_size_policy_parses() {
        assert_eq!(PageSizePolicy::parse("fit"), Some(PageSizePolicy::FitImage));
        assert_eq!(
            PageSizePolicy::parse("standard"),
            Some(PageSizePolicy::StandardPage)
        );
        assert_eq!(
            PageSizePolicy::parse("a4"),
            Some(PageSizePolicy::StandardPage)
        );
        assert_eq!(PageSizePolicy::parse("nope"), None);
        assert_eq!(PageSizePolicy::default(), PageSizePolicy::FitImage);
    }
}
