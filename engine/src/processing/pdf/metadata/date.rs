//! Typed PDF date handling (`/CreationDate`, `/ModDate`).
//!
//! PDF dates are fixed-format strings (`D:YYYYMMDDHHmmSSOHH'mm'`,
//! per §7.9.4 of the PDF specification), frequently partial or
//! malformed in real files. This module converts between those raw
//! strings and the application-level [`PdfDate`]:
//!
//! - [`parse_pdf_date`] is total: it returns [`None`] for anything it
//!   cannot represent rather than failing. Reading malformed metadata
//!   must never fail a document operation.
//! - [`PdfDate::new`] validates ranges and reports [`EngineError`]
//!   (`InvalidInput`), so constructed values are always well-formed.
//! - [`format_pdf_date`] emits the canonical full form, so every date
//!   Folio writes parses back to the identical value (round-trip).
//!
//! No timezone database is involved: PDF offsets are fixed
//! `±HH'mm'` values, representable as plain minutes (this is also why
//! the crate avoids `chrono` — see the `Cargo.toml` rationale).

use crate::core::error::{EngineError, ErrorCode};

/// An application-level PDF date: calendar fields plus a fixed
/// UTC offset in minutes (east positive, e.g. `+05'30'` → `330`).
///
/// Constructed via [`PdfDate::new`] (validated) or recovered from raw
/// strings via [`parse_pdf_date`] (total, never fails).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PdfDate {
    /// Four-digit year (e.g. `2026`).
    pub year: i32,
    /// Month of year, `1..=12`.
    pub month: u32,
    /// Day of month, `1..=days_in_month`.
    pub day: u32,
    /// Hour of day, `0..=23`.
    pub hour: u32,
    /// Minute of hour, `0..=59`.
    pub minute: u32,
    /// Second of minute, `0..=59` (leap seconds are not representable).
    pub second: u32,
    /// UTC offset in minutes, `-1439..=1439` (`+05'30'` → `330`).
    pub tz_offset_minutes: i32,
}

impl PdfDate {
    /// Builds a validated date. Out-of-range components fail as
    /// `InvalidInput` with the offending field named in `details`.
    pub fn new(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
        tz_offset_minutes: i32,
    ) -> Result<Self, EngineError> {
        let bad = |field: &str, value: i64| {
            EngineError::new(
                ErrorCode::InvalidInput,
                format!("metadata date field {field} is out of range: {value}"),
            )
            .with_details(format!("{field}={value}"))
        };
        if !(1..=9999).contains(&year) {
            return Err(bad("year", i64::from(year)));
        }
        if !(1..=12).contains(&month) {
            return Err(bad("month", i64::from(month)));
        }
        if day < 1 || day > days_in_month(year, month) {
            return Err(bad("day", i64::from(day)));
        }
        if hour > 23 {
            return Err(bad("hour", i64::from(hour)));
        }
        if minute > 59 {
            return Err(bad("minute", i64::from(minute)));
        }
        if second > 59 {
            return Err(bad("second", i64::from(second)));
        }
        if !(-1439..=1439).contains(&tz_offset_minutes) {
            return Err(bad("tz_offset_minutes", i64::from(tz_offset_minutes)));
        }
        Ok(Self {
            year,
            month,
            day,
            hour,
            minute,
            second,
            tz_offset_minutes,
        })
    }
}

/// Days in a month, leap-year aware (proleptic Gregorian calendar).
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Parses a raw PDF date string into a [`PdfDate`], or [`None`] when the
/// string is absent-shaped, partial beyond use, or malformed.
///
/// Accepted: optional `D:` prefix, then `YYYY` plus optional `MMDDHHmmSS`
/// pairs from the left (missing month/day default to `1`, missing time to
/// `00:00:00`), then an optional zone: `Z`, or `±HH` with optional `'mm'`
/// (apostrophes optional, e.g. `+0530` and `+05'30'` both work). Anything
/// else — non-digits in fixed positions, out-of-range components,
/// trailing garbage — yields [`None`]. Never panics, never errors.
#[must_use]
pub fn parse_pdf_date(raw: &str) -> Option<PdfDate> {
    let text = raw.trim();
    let text = text.strip_prefix("D:").unwrap_or(text);
    if text.len() < 4 || !text[..4].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year: i32 = text[..4].parse().ok()?;
    let mut rest = &text[4..];

    // Fixed-position digit pairs, left to right; absent pairs take the
    // documented defaults (month/day → 1, time → 0).
    let mut take_pair = |default: u32| -> Option<u32> {
        if rest.is_empty() {
            return Some(default);
        }
        if rest.len() < 2 {
            // A dangling single character can never form a pair.
            return None;
        }
        let (pair, tail) = rest.split_at(2);
        if !pair.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        rest = tail;
        pair.parse().ok()
    };
    let month = take_pair(1)?;
    let day = take_pair(1)?;
    let hour = take_pair(0)?;
    let minute = take_pair(0)?;
    let second = take_pair(0)?;

    let tz_offset_minutes = if rest.is_empty() || rest == "Z" {
        0
    } else {
        let sign = match rest.as_bytes().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        rest = &rest[1..];
        // Hours (required), optional minutes with optional apostrophes.
        if rest.len() < 2 || !rest[..2].bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let tz_hour: i32 = rest[..2].parse().ok()?;
        rest = &rest[2..];
        rest = rest.strip_prefix('\'').unwrap_or(rest);
        let tz_minute: i32 = if rest.is_empty() {
            0
        } else {
            if rest.len() < 2 || !rest[..2].bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let minutes: i32 = rest[..2].parse().ok()?;
            rest = &rest[2..];
            rest = rest.strip_prefix('\'').unwrap_or(rest);
            if !rest.is_empty() {
                return None;
            }
            minutes
        };
        sign * (tz_hour * 60 + tz_minute)
    };

    PdfDate::new(year, month, day, hour, minute, second, tz_offset_minutes).ok()
}

/// Formats a [`PdfDate`] in canonical full PDF form:
/// `D:YYYYMMDDHHmmSS` plus `Z` for UTC or `±HH'mm'` otherwise.
/// Every formatted value re-parses to the identical date.
#[must_use]
pub fn format_pdf_date(date: &PdfDate) -> String {
    let zone = if date.tz_offset_minutes == 0 {
        "Z".to_string()
    } else {
        let sign = if date.tz_offset_minutes < 0 { '-' } else { '+' };
        let magnitude = date.tz_offset_minutes.unsigned_abs();
        format!("{sign}{:02}'{:02}'", magnitude / 60, magnitude % 60)
    };
    format!(
        "D:{:04}{:02}{:02}{:02}{:02}{:02}{zone}",
        date.year, date.month, date.day, date.hour, date.minute, date.second,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
        tz: i32,
    ) -> PdfDate {
        PdfDate::new(year, month, day, hour, minute, second, tz).expect("valid fixture date")
    }

    #[test]
    fn parses_full_dates_with_zones() {
        assert_eq!(
            parse_pdf_date("D:20260123093000+05'30'"),
            Some(date(2026, 1, 23, 9, 30, 0, 330))
        );
        assert_eq!(
            parse_pdf_date("D:20260412185453-04'00'"),
            Some(date(2026, 4, 12, 18, 54, 53, -240))
        );
        assert_eq!(
            parse_pdf_date("D:20200101000000Z"),
            Some(date(2020, 1, 1, 0, 0, 0, 0))
        );
    }

    #[test]
    fn accepts_partial_dates_with_defaults() {
        // Year only, no prefix, compact zone spelling.
        assert_eq!(parse_pdf_date("2026"), Some(date(2026, 1, 1, 0, 0, 0, 0)));
        assert_eq!(
            parse_pdf_date("D:202602"),
            Some(date(2026, 2, 1, 0, 0, 0, 0))
        );
        assert_eq!(
            parse_pdf_date("D:2026020312"),
            Some(date(2026, 2, 3, 12, 0, 0, 0))
        );
        assert_eq!(
            parse_pdf_date("D:20260203120000+0530"),
            Some(date(2026, 2, 3, 12, 0, 0, 330))
        );
        assert_eq!(
            parse_pdf_date("D:20260203120000+05"),
            Some(date(2026, 2, 3, 12, 0, 0, 300))
        );
    }

    #[test]
    fn rejects_malformed_dates_as_none() {
        for bad in [
            "",
            "today",
            "D:",
            "D:20",
            "D:20AB",
            "D:2026-01-23",
            "D:20261301",
            "D:20260230",
            "D:20260101250000",
            "D:20260101126000",
            "D:20260101125960",
            "D:20260101X",
            "D:20260101000000+25'00'",
            "D:20260101000000+05'30'junk",
            "D:20260101000000 ",
        ] {
            // Note: trailing whitespace is trimmed before parsing, so the
            // last entry parses; every other entry must yield None.
            if bad == "D:20260101000000 " {
                assert!(
                    parse_pdf_date(bad).is_some(),
                    "{bad:?} trims to a valid date"
                );
            } else {
                assert_eq!(parse_pdf_date(bad), None, "{bad:?} must not parse");
            }
        }
    }

    #[test]
    fn constructor_validates_ranges() {
        assert!(PdfDate::new(2026, 13, 1, 0, 0, 0, 0).is_err());
        assert!(PdfDate::new(2026, 2, 30, 0, 0, 0, 0).is_err());
        assert!(PdfDate::new(2024, 2, 29, 0, 0, 0, 0).is_ok());
        assert!(PdfDate::new(2023, 2, 29, 0, 0, 0, 0).is_err());
        assert!(PdfDate::new(2026, 1, 1, 24, 0, 0, 0).is_err());
        assert!(PdfDate::new(2026, 1, 1, 0, 0, 0, 1440).is_err());
        assert!(PdfDate::new(2026, 1, 1, 0, 0, 0, -1439).is_ok());
        let err = PdfDate::new(2026, 13, 1, 0, 0, 0, 0).expect_err("month 13 fails");
        assert_eq!(err.code(), ErrorCode::InvalidInput);
        assert!(err.details().is_some_and(|d| d.contains("month=13")));
    }

    #[test]
    fn formatting_round_trips() {
        for raw in [
            "D:20260123093000+05'30'",
            "D:20260412185453-04'00'",
            "D:20200101000000Z",
            "D:19981231235959+00'00'",
        ] {
            let parsed = parse_pdf_date(raw).expect("parses");
            let formatted = format_pdf_date(&parsed);
            assert_eq!(
                parse_pdf_date(&formatted),
                Some(parsed),
                "formatted {formatted:?} must re-parse"
            );
        }
        assert_eq!(
            format_pdf_date(&date(2026, 1, 23, 9, 30, 0, 330)),
            "D:20260123093000+05'30'"
        );
        assert_eq!(
            format_pdf_date(&date(2020, 1, 1, 0, 0, 0, 0)),
            "D:20200101000000Z"
        );
    }
}
