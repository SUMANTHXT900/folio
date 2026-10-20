/**
 * ScanicCapture — camera session + result-FIRST review queue for document scanning.
 *
 * Full-screen takeover: the scanner root is portaled to `document.body` as a
 * `fixed inset-0 z-50` surface (Folio paper/ink theme) with body scroll-lock
 * while mounted. The camera phase leads with a full-bleed viewfinder — no
 * scroll needed to find it. The portal is NEVER wrapped in AnimatePresence.
 *
 * Detection is ML-only (D46 — self-hosted same-origin assets under
 * `public/assets/scanic-ml/`, precached at install). An ML miss means the
 * full frame is used, never a guessed crop. Corner *types* come from the worker agent's barrel
 * (`./scan/index`), the single source of truth; detection + warp run through
 * `ScanicClient` (`./scan/scanicClient`) on the module scan worker — scanic
 * never executes on the main thread here (the worker self-warms its own ML
 * session at startup). The DOM contract below is byte-for-byte the same as
 * the old inline runtime, so unit + E2E selectors keep holding.
 *
 * Retained-client seam (ML-CORE landed): `getRetainedDetectClient()` owns the
 * mount-lifetime detect client (warm ORT session reused across drains +
 * Re-detect); `acquireDetectionPool()` staffs each drain's K lanes with lane
 * 0 = retained, `detectionLaneClient()` indexes lanes directly (no modulo),
 * and `releaseOwned()` frees pool-owned lanes only (never the retained lane
 * — unmount alone calls `releaseRetainedDetectClient()`). Detection results
 * carry `instrumentation`; dev-only `console.debug` telemetry logs it plus
 * the read-only EXIF probe and per-item queue spans (measure-only, no
 * behavior).
 *
 * Viewfinder modules (surgical refactor, pipeline untouched —
 * takePhoto→queue→drain→warp→commit is byte-identical in behavior):
 * `FinderChrome` (ONE overlay top bar: close + title + More; a single
 * overflow sheet owns every secondary control), `Finder` (video + ticks +
 * one ACTIONABLE status pill, quiet otherwise), shutter cluster (shutter +
 * slim count bar + bottom-right gallery count entry + reserved CTA slot),
 * `ReviewShell` (non-blocking preparing banner; ready pages stay
 * interactive — viewing-is-verdict).
 *
 * Preview vs detection: the <video> preview pixels are NEVER the detection
 * input — detection runs on the captured still through scanic's own internal
 * downscale (the worker scales to detection size itself). Preview
 * resolution (up to 1080p) only affects what the user sees.
 *
 * Mirror invariant: the front-camera preview is CSS-mirrored (`scaleX(-1)`,
 * industry standard) for a natural selfie feel, but captured frames are
 * ALWAYS unmirrored — `ImageCapture.takePhoto()` returns the sensor-native
 * Blob (never the CSS transform), and the canvas-draw fallback reads raw
 * camera pixels via `drawImage(video)` (likewise never the CSS transform).
 * The back camera is never mirrored.
 *
 * Original-blob capture: the shutter uses the ImageCapture API
 * (`new ImageCapture(track).takePhoto()`) so the queued File is the
 * sensor's native encoding — no canvas, no toBlob, no quality param, zero
 * encode/decode. Canvas-draw is a fallback ONLY when ImageCapture is
 * unavailable or throws (older browsers, Firefox without ImageCapture,
 * virtual cameras that reject takePhoto). takePhoto resolution requests the
 * `getPhotoCapabilities()` max when exposed (best original), else the
 * native default (bare `takePhoto()`).
 *
 * Camera choice: after permission, `enumerateDevices()` lists video inputs;
 * the `[data-camera-select]` native select (alongside the facing quick-flip)
 * restarts the session with `deviceId: { exact }`, falling back to
 * facingMode ideals on failure. The choice persists in a session ref and in
 * `localStorage` (`folio.scan.cameraId`) so the eventual pick wins on the
 * next open (validated against the fresh enumeration, else the default flow).
 *
 * Orientation-honest constraints: ideals come from screen orientation at
 * session start — portrait screens keep portrait ideals (1080x1920 back /
 * 720x1280 front); landscape screens request landscape max (1920x1080 with
 * a `width: { min: 1280 }` floor). No portrait crop is ever forced on a
 * landscape sensor. The preview is full-bleed `object-cover` (no forced
 * ratio anywhere, no `aspectRatio` styling on the video — the cover layer
 * crops, never stretches, so a 1440p landscape webcam never renders as a
 * blurry zoomed crop).
 *
 * E2E DATA CONTRACT (do not rename):
 * - root `[data-scanner-root]` (+ `data-detector="ml"`), shutter
 *   `[data-scan-capture]` (rendered only when live), gallery thumb
 *   `[data-scan-gallery]` (last queued thumb, jumps to review), mode pill
 *   `[data-scan-mode]` (`Manual` default / `Auto capture`, lives in the
 *   overflow sheet), queue `[data-scan-queue]` with header `Page i of N`,
 *   result `[data-crop-result]` + `[data-crop-result-img]`, handles
 *   `[data-crop-handle="tl|tr|br|bl"]` (role=slider, arrow-key
 *   steppable via scanic's keyboard mode), review CTA `[data-review-cta]`
 *   (`View N pages` — every queued page is implicitly accepted, no pending;
 *   the slim count bar in the reserved strip slot), progress
 *   `[data-review-progress]` (aria-label `i of N viewed`, visited
 *   count — INTENTIONAL contract change from `reviewed`), pager
 *   `[data-page-prev]` / `[data-page-next]` (44px, disabled at ends) +
 *   `[data-page-dot]` (44px page dots, `aria-current` on current), finder
 *   `[data-finder-frame]` + `[data-finder-status]` (rendered ONLY when
 *   actionable: starting / paused / captured-flash / Auto hold-steady /
 *   denied-retry help — quiet Manual idle renders NO pill), mirror
 *   `[data-mirror-toggle]` (aria-pressed, lives in the overflow sheet),
 *   filmstrip `[data-scan-filmstrip]` + `[data-film-thumb]` (numbered, tap
 *   jumps) + `[data-scan-add]` (back to camera), batch bar
 *   `[data-batch-bar]` (`Discard scans` ghost / `Next` primary, gated on
 *   >=1 page), overflow `[data-scan-more]` (trigger, `aria-expanded`) +
 *   `[data-scan-sheet]` (always mounted in the camera phase, hidden when
 *   closed — flash, flip, mirror, camera select, mode, import rows).
 * - Additive (VF-BUILD, E2E-safe): gallery `[data-gallery-count]` visible
 *   count badge, mirror `[data-mirror-note]` inline back-camera reason,
 *   non-blocking `[data-review-preparing]` slim banner (same text + role —
 *   pager/filmstrip/Add/Next stay enabled while it shows).
 * - Queue button labels are EXACT: "Adjust corners", "Apply",
 *   "Use original" (toggle warped <-> original), "Discard", "Reset to auto",
 *   "Build PDF", "Back to camera", "Re-detect", "Previous page",
 *   "Next page", "Next", "Discard scans". No "Looks good" exists anywhere —
 *   seeing a fine page is enough to move on (implicit accept).
 *
 * Binary ownership: originals live as File handles in refs/state (never
 * re-encoded, never base64); only object-URL strings enter React state, and
 * every URL is revoked on discard/commit/unmount. Warped commits are full-res
 * JPEG q0.9 renders of the worker's warp output via `imageDataToJpeg(0.9)` —
 * warped pages are NEW renders (never original bytes; originals still pass
 * through byte-identical when inside the import pixel budget), and JPEG q0.9
 * full-res cuts multi-MB PNG bloat to a fraction with no readable-text loss
 * (4-page 22MB class problem). Commits run through `prepareImportFile`
 * normalization (same pixel budget as gallery imports) so 48MP sensor photos
 * can't bypass it — the commit never loses a page (normalization failure
 * falls back to the candidate file). Committed warped files keep
 * `scan-NNN.jpg` names with `image/jpeg` type.
 *
 * Corner adjust lives in `./ScanicReview` (dependency-free handles on the
 * overlay coordinate space, same E2E labels + 44px targets); this file owns
 * queue/camera/commit only and re-warps on every Apply so previews stay
 * reactive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { prepareImportFile } from './imageImport';
import type { ScanicCorners } from './scan/index';
import {
  DEFAULT_DETECTOR,
  ML_ASSET_BASE_URL as POLICY_ML_ASSET_BASE_URL,
  resolveDetectionWorkerCount,
} from './scan/detectorPolicy';
import { runReviewDetectionQueue, createReviewSpanCollector } from './scan/reviewDetection';
import {
  ScanicClient,
  ScanicClientError,
  acquireDetectionPool,
  detectionLaneClient,
  getRetainedDetectClient,
  releaseRetainedDetectClient,
  type DetectionPool,
} from './scan/scanicClient';
import { probeExifOrientation, type ExifProbeResult } from './scan/exifProbe';
import type { ScanicDetectInstrumentation } from './scan/scanicProtocol';
import ScanicReview from './ScanicReview';
import {
  isCaptureSpansEnabled,
  logCaptureSpansTable,
  markCaptureSpan,
  resetCaptureSpans,
} from './captureSpans';

/** Self-hosted (same-origin) ML detector assets — ML is the default (re-exported policy value; kept here for test compat). */
export const SCANIC_ML_ASSET_BASE_URL = POLICY_ML_ASSET_BASE_URL;

/** E2E short keys for the four corner handles. */
export const SCANIC_HANDLE_KEYS = ['tl', 'tr', 'br', 'bl'] as const;
export type ScanicHandleKey = (typeof SCANIC_HANDLE_KEYS)[number];

/** `scan-NNN.jpg` collection names (capture order; engine sniffs magic bytes). */
export function formatScanName(index: number): string {
  return `scan-${String(index + 1).padStart(3, '0')}.jpg`;
}

/* ------------------------------------------------------------------ */
/* Camera choice + orientation-honest constraints                      */
/* ------------------------------------------------------------------ */

/**
 * Session-persisted camera choice: module lifetime equals the page-session
 * lifetime, so a remount (StrictMode double-mount, camera↔review trips that
 * tear down the session effect) keeps the user's pick without localStorage.
 * Mirrored into `chosenDeviceIdRef` + state below on every change.
 */
let persistedCameraDeviceId: string | null = null;

/** Cross-session camera pick (the user's eventual explicit choice). */
export const CAMERA_STORAGE_KEY = 'folio.scan.cameraId';

/**
 * Bare-capture experiment flag (F-22 experiment B): the SAME key the
 * shutter (`captureFrame`) reads per-capture — `'1'` takes the
 * sensor-native default (bare `takePhoto()`), anything else is Max detail.
 * Toggle-owned only; the capture path itself is untouched.
 */
export const BARE_CAPTURE_STORAGE_KEY = 'folio-bare-capture';

/**
 * Default OFF: only the exact value `'1'` opts into bare capture.
 * Absent/invalid/unreadable storage is Max detail (existing behavior).
 */
function readBareCaptureFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem(BARE_CAPTURE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Length cap for a stored camera pick. Real `deviceId` values are short
 * opaque tokens (tens of chars); 256 is generous headroom that still bounds
 * what a same-origin-writable `localStorage` value can push into
 * `deviceId: { exact }` constraints.
 */
export const MAX_STORED_CAMERA_ID_LENGTH = 256;

/**
 * Length/charset clamp for a stored camera pick (pure, unit-tested).
 * `localStorage` is same-origin writable (devtools, older builds, pasted
 * values), so the stored id is untrusted on read: overlong values and
 * anything carrying C0/C1 controls or DEL is rejected to `null` and the
 * session falls back to the default facingMode flow. Printable ids —
 * including non-ASCII labels some platforms emit — pass through untouched.
 */
export function clampStoredCameraId(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.length > MAX_STORED_CAMERA_ID_LENGTH) return null;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 128 && code < 160)) return null;
  }
  return raw;
}

function readStoredCameraId(): string | null {
  try {
    return clampStoredCameraId(globalThis.localStorage?.getItem(CAMERA_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredCameraId(id: string): void {
  try {
    globalThis.localStorage?.setItem(CAMERA_STORAGE_KEY, id);
  } catch {
    // Private mode / blocked storage — session ref still wins within a session.
  }
}

function clearStoredCameraId(): void {
  try {
    globalThis.localStorage?.removeItem(CAMERA_STORAGE_KEY);
  } catch {
    // Private mode — nothing to clear.
  }
}

/** First-open choice: session ref wins, else the stored pick, else default. */
function initialCameraChoice(): string | null {
  if (persistedCameraDeviceId !== null) return persistedCameraDeviceId;
  return readStoredCameraId();
}

/** Minimal ImageCapture surface used here (avoids lib.dom version skew). */
interface TakePhotoCapabilities {
  imageWidth?: { max?: number };
  imageHeight?: { max?: number };
}
interface ImageCaptureInstance {
  getPhotoCapabilities?: () => Promise<TakePhotoCapabilities>;
  takePhoto: (settings?: { imageWidth?: number; imageHeight?: number }) => Promise<Blob>;
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureInstance;

function getImageCaptureCtor(): ImageCaptureCtor | undefined {
  try {
    const ctor = (globalThis as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    return typeof ctor === 'function' ? ctor : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Platform limit (documented, never worked around by fabrication): browsers
 * expose LOGICAL cameras only — hidden physical lenses (wide / ultra-wide /
 * tele behind one logical device) can never be enumerated. `enumerateDevices`
 * returns exactly what the platform exposes; this file never fabricates a
 * third entry when two are listed.
 *
 * Likewise no getUserMedia constraint distinguishes wide vs ultra-wide: the
 * W3C `focalLength` / lens-selection extension (mediacapture-extensions#20,
 * open since 2020) never shipped, so "best camera" must be PROBED (per-device
 * max photo resolution) never constrained.
 */
function capabilitiesMaxPixels(caps: unknown): number | null {
  try {
    const c = caps as { width?: unknown; height?: unknown } | null | undefined;
    if (!c || typeof c !== 'object') return null;
    const maxOf = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
      if (v !== null && typeof v === 'object') {
        const m = (v as { max?: unknown }).max;
        if (typeof m === 'number' && Number.isFinite(m) && m > 0) return m;
      }
      return null;
    };
    const w = maxOf(c.width);
    const h = maxOf(c.height);
    if (w !== null && h !== null) return w * h;
    return null;
  } catch {
    return null;
  }
}

/** Max photo pixels for a live track: ImageCapture photo caps, else track caps. */
async function maxPixelsForTrack(track: MediaStreamTrack): Promise<number | null> {
  const Ctor = getImageCaptureCtor();
  if (Ctor) {
    try {
      const capture = new Ctor(track);
      if (typeof capture.getPhotoCapabilities === 'function') {
        const caps = await capture.getPhotoCapabilities();
        const w = caps.imageWidth?.max;
        const h = caps.imageHeight?.max;
        if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
          return w * h;
        }
      }
    } catch {
      // Fall through to the track-capabilities fallback below.
    }
  }
  try {
    const caps = (track as { getCapabilities?: () => unknown }).getCapabilities?.();
    return capabilitiesMaxPixels(caps);
  } catch {
    return null;
  }
}

/**
 * Main-lens default scoring (best-effort heuristic, NOT a lens constraint).
 *
 * No getUserMedia constraint distinguishes wide vs ultra-wide (open W3C
 * mediacapture-extensions#20 issue — verified 2026-10-04, never shipped), so
 * "best back camera" must be PROBED and scored, never constrained. Inputs are
 * the only three signals browsers expose:
 * - `label` keywords (needs permission; blank/generic labels score 0 here),
 * - `hasZoom` (PTZ `zoom` capability min!==max, Chrome 87+ — main/tele lenses
 *   advertise a zoom range, fixed ultra-wide/macro lenses typically don't),
 * - `maxPixels` probe (per-device max photo resolution, /1e6 tiebreak only).
 *
 * Scores rank ENUMERATED logical cameras only — this file never fabricates a
 * device (see the platform-limit note above). The persisted user pick always
 * wins overall; the suggestion probe keeps its >25% pixel gate AND picks the
 * highest score (so a huge-but-ultra-wide sensor loses to a plain main lens).
 *
 * Limits: label-dependent (OEM labels vary; `0.5x`/ultra hints are the only
 * wide signal), capability-gated (many browsers hide PTZ zoom; then hasZoom is
 * false everywhere and pixels decide), never a physical-lens guarantee (hidden
 * lenses behind one logical device stay platform-invisible).
 */
export function scoreBackCamera(input: {
  label: string;
  maxPixels: number | null;
  hasZoom: boolean;
}): number {
  let score = 0;
  if (/ultra|0\.5x?|wide.?angle|fisheye|macro/i.test(input.label)) score -= 100;
  if (input.hasZoom) score += 50;
  if (
    typeof input.maxPixels === 'number' &&
    Number.isFinite(input.maxPixels) &&
    input.maxPixels > 0
  ) {
    score += input.maxPixels / 1e6;
  }
  return score;
}

/**
 * True when a capabilities object advertises a real zoom range (min!==max).
 * Accepts track `getCapabilities()` or ImageCapture `getPhotoCapabilities()`
 * shapes — anything missing/non-numeric is capability-gated to false.
 */
export function hasZoomCapability(caps: unknown): boolean {
  try {
    if (!caps || typeof caps !== 'object') return false;
    const zoom = (caps as { zoom?: unknown }).zoom;
    if (!zoom || typeof zoom !== 'object') return false;
    const min = (zoom as { min?: unknown }).min;
    const max = (zoom as { max?: unknown }).max;
    if (typeof min !== 'number' || typeof max !== 'number') return false;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
    return min !== max;
  } catch {
    return false;
  }
}

/** Zoom signal for a live track: track caps first, ImageCapture photo caps as fallback. */
async function hasZoomForTrack(track: MediaStreamTrack): Promise<boolean> {
  try {
    const caps = (track as { getCapabilities?: () => unknown }).getCapabilities?.();
    if (hasZoomCapability(caps)) return true;
  } catch {
    // Fall through to the ImageCapture check below.
  }
  const Ctor = getImageCaptureCtor();
  if (Ctor) {
    try {
      const capture = new Ctor(track);
      if (typeof capture.getPhotoCapabilities === 'function') {
        const photoCaps = (await capture.getPhotoCapabilities()) as unknown;
        if (hasZoomCapability(photoCaps)) return true;
      }
    } catch {
      // Capability-gated: treat as no zoom.
    }
  }
  return false;
}

/**
 * True on landscape screens. Reads `screen.orientation.type` when exposed
 * (all modern browsers, incl. desktop Chrome `landscape-primary`); when the
 * API is missing (older browsers, jsdom) defaults to portrait — deliberately
 * NOT `innerWidth > innerHeight`, because jsdom reports 1024x768 landscape
 * and would otherwise force landscape ideals in tests and on phones caught
 * mid-rotation. Real landscape desktops always expose the orientation API,
 * so they still get landscape ideals.
 */
export function isLandscapeScreen(): boolean {
  try {
    const w = window as unknown as {
      screen?: { orientation?: { type?: string } };
    };
    const t = w.screen?.orientation?.type;
    if (typeof t === 'string') {
      if (t.startsWith('landscape')) return true;
      if (t.startsWith('portrait')) return false;
    }
  } catch {
    // Fall through to the portrait default below.
  }
  return false;
}

/**
 * Orientation-honest `getUserMedia` video constraints built at session start.
 * Portrait screens keep the phone-tall ideals (1080x1920 back / 720x1280
 * front); landscape screens request landscape max (1920x1080 with a
 * `width: { min: 1280 }` floor so a 1440p landscape webcam is never squeezed
 * through a portrait crop and upscaled into blur). All ideals are
 * non-binding hints — the sensor settles to its closest native mode; only
 * the landscape `min: 1280` floor can over-constrain, and the session effect
 * retries without it on `OverconstrainedError`.
 *
 * With an explicit `deviceId` the facingMode hint is omitted (exact device
 * selection conflicts with facingMode on some browsers); without one,
 * `facingMode: { ideal }` applies.
 */
export function buildVideoConstraints(
  facing: 'environment' | 'user',
  deviceId?: string | null,
): MediaTrackConstraints {
  const base: MediaTrackConstraints =
    deviceId !== null && deviceId !== undefined && deviceId !== ''
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: facing } };
  if (isLandscapeScreen()) {
    return { ...base, width: { ideal: 1920, min: 1280 }, height: { ideal: 1080 } };
  }
  if (facing === 'user') {
    return { ...base, width: { ideal: 720 }, height: { ideal: 1280 } };
  }
  return { ...base, width: { ideal: 1080 }, height: { ideal: 1920 } };
}

/**
 * Display name for a video input: the OS/browser label when permission has
 * granted it, else an honest fallback (`Camera N`) — always prefixed with
 * the ordered index (`1: …`) so duplicate/blank labels stay distinguishable.
 * Callers needing Front/Back wording get it free when the label itself (or
 * the facing fallback) carries it; the index suffix is the disambiguator.
 */
export function cameraDisplayName(
  device: { label?: string | null },
  index: number,
  facingHint?: 'environment' | 'user' | null,
): string {
  const raw = (device.label ?? '').trim();
  if (raw !== '') return `${index + 1}: ${raw}`;
  const side = facingHint === 'user' ? 'Front' : facingHint === 'environment' ? 'Back' : null;
  if (side !== null) return `${index + 1}: ${side} camera ${index + 1}`;
  return `Camera ${index + 1}`;
}

/** Test-only reset for the session-persisted camera pick (isolates picker tests). */
export function __resetCameraChoiceForTests(): void {
  persistedCameraDeviceId = null;
}

/** Plain-language camera failure line per error type (never a bare "something went wrong"). */
export function cameraFailureMessage(
  kind: 'denied' | 'missing' | 'overconstrained' | 'unavailable',
): string {
  if (kind === 'denied')
    return 'Camera access was denied. Folio only uses the camera while this scanner is open. Allow access in the browser site settings and retry — or add image files instead.';
  if (kind === 'missing')
    return 'No camera was found on this device or browser. Connect a camera and retry — or add image files instead; they stay on this device.';
  if (kind === 'overconstrained')
    return 'That camera could not provide the requested resolution, so a compatible mode was tried instead. If the preview stays black, add image files instead — they stay on this device.';
  return 'No camera is available on this device or browser. Add image files instead — they stay on this device.';
}

function classifyCameraError(e: unknown): 'denied' | 'missing' | 'overconstrained' | 'unavailable' {
  const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'missing';
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError')
    return 'overconstrained';
  return 'unavailable';
}

/* ------------------------------------------------------------------ */
/* Auto capture (SAD stability shutter)                                */
/* ------------------------------------------------------------------ */

/**
 * Preview sampling grid for the stability shutter — tiny on purpose: the
 * <video> preview pixels are NEVER the detection input, and here they are
 * only a steadiness signal, so 48x27 grayscale is plenty.
 */
export const AUTO_CAPTURE_SAMPLE_W = 48;
export const AUTO_CAPTURE_SAMPLE_H = 27;
/** Mean per-pixel absolute difference at/below which a tick counts as steady. */
export const AUTO_CAPTURE_MEAN_THRESHOLD = 12;
/** Consecutive steady ticks required before the shutter fires. */
export const AUTO_CAPTURE_STABLE_TICKS_REQUIRED = 4;
/** Sampling cadence while auto mode is armed. */
export const AUTO_CAPTURE_TICK_MS = 300;
/** Minimum spacing between two auto shutter fires (static frames included). */
export const AUTO_CAPTURE_COOLDOWN_MS = 1500;

/**
 * Captured-flash window: after each queue-only shutter park the quiet finder
 * pill flashes `Captured — keep shooting` for this long (actionable voice,
 * then back to quiet). Repaints via state tick; never blocks any action.
 */
export const CAPTURE_FLASH_MS = 900;

/**
 * Sum of absolute differences between two equal-length grayscale frames.
 * Length mismatch (or anything unreadable) is maximally different.
 */
export function grayscaleSAD(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sad = 0;
  for (let i = 0; i < a.length; i += 1) sad += Math.abs(a[i] - b[i]);
  return sad;
}

/**
 * Steady when the mean per-pixel difference is within threshold — a
 * perfectly static preview (SAD 0) counts as steady; the cooldown (not this
 * comparator) is what bounds repeat fires on a frozen frame.
 */
export function isStableFrame(
  sad: number,
  pixelCount: number,
  meanThreshold: number = AUTO_CAPTURE_MEAN_THRESHOLD,
): boolean {
  if (!Number.isFinite(sad) || pixelCount <= 0) return false;
  return sad / pixelCount <= meanThreshold;
}

/**
 * Fire only after N consecutive steady ticks AND outside the cooldown window
 * since the last fire (manual or auto). `lastFireMs` null = never fired.
 */
export function shouldAutoFire(
  stableTicks: number,
  nowMs: number,
  lastFireMs: number | null,
  requiredTicks: number = AUTO_CAPTURE_STABLE_TICKS_REQUIRED,
  cooldownMs: number = AUTO_CAPTURE_COOLDOWN_MS,
): boolean {
  if (stableTicks < requiredTicks) return false;
  if (lastFireMs === null) return true;
  return nowMs - lastFireMs >= cooldownMs;
}

/** Shared auto-capture sampler canvas (one 48x27 allocation, reused per tick). */
let samplerCanvas: HTMLCanvasElement | null = null;

/** Downscaled grayscale snapshot of the live preview; null when unreadable. */
function samplePreviewGrayscale(video: HTMLVideoElement): Uint8Array | null {
  try {
    // One shared 48x27 sampler for the whole session: the auto-capture tick
    // fires every 300ms and must never allocate a canvas per tick.
    if (samplerCanvas === null) {
      samplerCanvas = document.createElement('canvas');
      samplerCanvas.width = AUTO_CAPTURE_SAMPLE_W;
      samplerCanvas.height = AUTO_CAPTURE_SAMPLE_H;
    }
    const ctx = samplerCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, AUTO_CAPTURE_SAMPLE_W, AUTO_CAPTURE_SAMPLE_H);
    const data = ctx.getImageData(0, 0, AUTO_CAPTURE_SAMPLE_W, AUTO_CAPTURE_SAMPLE_H).data;
    const gray = new Uint8Array(AUTO_CAPTURE_SAMPLE_W * AUTO_CAPTURE_SAMPLE_H);
    for (let i = 0; i < gray.length; i += 1) {
      gray[i] = Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
    }
    return gray;
  } catch {
    return null;
  }
}

export interface ScanicCommittedPage {
  file: File;
  name: string;
}

export interface ScanicCaptureProps {
  /** Receives accepted pages in capture order (warped JPEG or original File). */
  onCommit: (pages: ScanicCommittedPage[]) => void;
  /** Leaves the scanner without committing (Back in ImagesTool). */
  onExit: () => void;
  /** Offset for `scan-NNN.jpg` numbering (existing camera pages). */
  startIndex?: number;
}

type CameraState = 'requesting' | 'live' | 'denied' | 'unavailable' | 'insecure';
type Phase = 'camera' | 'review' | 'done';

interface QueueEntry {
  id: number;
  original: File;
  photoUrl: string;
  imageWidth: number;
  imageHeight: number;
  /** Detection baseline in image-space pixels; null while queued/detecting/failed. */
  corners: ScanicCorners | null;
  warpedUrl: string | null;
  /**
   * Queue-only lifecycle: `queued` parks the untouched original with its
   * photo thumb (shutter never decodes, never touches a worker);
   * `detecting` runs deferred in review; `ready` settles the verdict.
   */
  status: 'queued' | 'detecting' | 'ready';
  /**
   * Render verdict only (no pending — every queued page is implicitly
   * accepted): `warped` uses the warped JPEG when available else the
   * original; `original` always uses the byte-identical original.
   * Defaults to `warped` (implicit accept with current crop).
   */
  decision: 'warped' | 'original';
  note: string | null;
}

/** Loads an <img> for scanic; resolves unloaded on watchdog so jsdom never hangs. */
function loadImage(
  url: string,
  timeoutMs = 8000,
): Promise<{ el: HTMLImageElement; w: number; h: number }> {
  return new Promise((resolve) => {
    const el = new Image();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ el, w: el.naturalWidth || el.width || 0, h: el.naturalHeight || el.height || 0 });
    };
    const timer = window.setTimeout(done, timeoutMs);
    el.onload = () => {
      window.clearTimeout(timer);
      done();
    };
    el.onerror = () => {
      window.clearTimeout(timer);
      done();
    };
    el.src = url;
  });
}

/**
 * Exact-size 2D canvas; null when the platform has no canvas 2D (jsdom).
 * Warp/decode callers treat null as an honest failure, never a fallback.
 */
function makeCanvas(width: number, height: number): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width));
    canvas.height = Math.max(1, Math.floor(height));
    return canvas;
  } catch {
    return null;
  }
}

/**
 * Decodes an ORIGINAL File into a full-resolution ImageData COPY for the
 * scan worker. The worker transfers (neuters) the pixels it receives, so
 * every detection/warp needs its own copy; the File bytes are never
 * touched. `createImageBitmap` is preferred (no DOM element); the
 * object-URL `<img>` path is the fallback for older browsers.
 */
async function decodeFileToImageData(file: File): Promise<ImageData> {
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(`could not decode ${file.name}`);
    }
    try {
      const canvas = makeCanvas(bitmap.width, bitmap.height);
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });
      if (!canvas || !ctx) throw new Error('2D canvas unavailable for scan decode');
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
      try {
        bitmap.close();
      } catch {
        // Release is best-effort; the copy is already detached.
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const { el, w, h } = await loadImage(url);
    if (w === 0 || h === 0) {
      throw new Error(`could not decode ${file.name}`);
    }
    const canvas = makeCanvas(w, h);
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !ctx) throw new Error('2D canvas unavailable for scan decode');
    ctx.drawImage(el, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Warped-page encoder: worker warp ImageData → full-res `image/jpeg` at
 * quality 0.9 (null when the platform cannot encode).
 *
 * Rationale: warped pages are NEW renders (never original bytes — originals
 * still pass through byte-identical when inside the import pixel budget),
 * and JPEG q0.9 full-res cuts multi-MB PNG bloat to a fraction with no
 * readable-text loss (4-page 22MB class problem). Committed warped files
 * keep `scan-NNN.jpg` names with `image/jpeg` type. Full-res means the warp
 * output pixels as-is (no downscale); only the container changes.
 */
function imageDataToJpeg(image: ImageData, quality = 0.9): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const canvas = makeCanvas(image.width, image.height);
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) {
        resolve(null);
        return;
      }
      ctx.putImageData(image, 0, 0);
      if (typeof canvas.toBlob !== 'function') {
        resolve(null);
        return;
      }
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* FinderChrome: ONE overlay top bar (no variants)                     */
/* ------------------------------------------------------------------ */

interface FinderChromeProps {
  onExit: () => void;
  /** Overflow trigger state (camera phase only). */
  sheetOpen: boolean;
  onToggleSheet: () => void;
  /**
   * Overflow sheet content. Null outside the camera phase — review/done
   * chrome is Close + title only. When non-null the sheet panel
   * (`[data-scan-sheet]`) stays mounted and hides via CSS, so every
   * camera-phase hook (mode, mirror, select, torch, suggest, fallback)
   * keeps holding without ever covering the finder uninvited.
   */
  sheet: ReactNode | null;
}

/**
 * The single top-bar implementation: close (top-left), title, and the
 * overflow trigger (top-right). Every interactive control carries
 * `pointer-events-auto` so the overlay scrim (pass-through by design) can
 * never swallow a tap (L-24 — pinned by the hit-test suite). The sheet
 * rows below carry the labeled 44px controls (L-24 label visibility lives
 * in the sheet while the finder stays clean).
 */
function FinderChrome({ onExit, sheetOpen, onToggleSheet, sheet }: FinderChromeProps) {
  const chromeButton =
    'pointer-events-auto relative inline-flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-xl border border-paper-50/20 bg-ink-950/60 px-2 py-1 text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80';
  return (
    <div
      data-scanner-topbar
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-1 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      <div className="relative flex w-full items-center gap-1">
        <button type="button" aria-label="Close scanner" onClick={onExit} className={chromeButton}>
          <span aria-hidden className="text-sm leading-none">
            ✕
          </span>
          <span className="text-[10px] font-medium leading-none">Close</span>
        </button>
        <p className="relative min-w-0 flex-1 truncate rounded-xl bg-ink-950/60 px-3 py-1 text-center font-display text-sm font-semibold tracking-tight text-paper-50 backdrop-blur">
          Scan documents
        </p>
        {sheet !== null ? (
          <button
            type="button"
            data-scan-more
            aria-label="More options"
            aria-expanded={sheetOpen}
            aria-controls="scan-sheet"
            onClick={onToggleSheet}
            className={chromeButton}
          >
            <span aria-hidden className="text-sm leading-none">
              ⋯
            </span>
            <span className="text-[10px] font-medium leading-none">More</span>
          </button>
        ) : (
          <span aria-hidden className="min-h-[44px] min-w-[44px]" />
        )}
      </div>
      {sheet !== null && (
        <div
          data-scan-sheet
          id="scan-sheet"
          className={
            sheetOpen
              ? 'pointer-events-auto relative w-full rounded-2xl bg-paper-50 shadow-soft dark:bg-ink-900'
              : 'hidden'
          }
        >
          {sheet}
        </div>
      )}
    </div>
  );
}

/** One labeled 44px sheet row (button variant): icon + visible label + optional state. */
function SheetRowButton({
  icon,
  label,
  state,
  onClick,
  pressed,
  disabled,
  ariaLabel,
  title,
  dataAttr,
}: {
  icon: ReactNode;
  label: string;
  state?: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  /**
   * Explicit accessible name. Omit when the visible label IS the name
   * (then the button is found by its text, never by label query) — this
   * keeps `getByLabelText` unambiguous for the hidden file input that
   * shares the Import copy.
   */
  ariaLabel?: string;
  title?: string;
  /** Extra data-* hooks (contract attributes) spread onto the row button. */
  dataAttr?: Record<string, string>;
}) {
  // No `aria-label` when the visible label IS the name: the accessible name
  // comes from content, so label queries stay unambiguous for the hidden
  // file input that shares the Import copy.
  const nameProps = ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {};
  return (
    <button
      type="button"
      {...nameProps}
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      {...dataAttr}
      onClick={onClick}
      className="pointer-events-auto inline-flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium text-ink-900 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-paper-100 dark:hover:bg-ink-700"
    >
      <span aria-hidden className="text-base leading-none">
        {icon}
      </span>
      <span>{label}</span>
      {state !== undefined && (
        <span className="ml-auto text-xs font-normal text-ink-400 dark:text-ink-300">{state}</span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* ScanicCapture                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* ScanicCapture                                                       */
/* ------------------------------------------------------------------ */

export default function ScanicCapture({ onCommit, onExit, startIndex = 0 }: ScanicCaptureProps) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [phase, setPhase] = useState<Phase>('camera');
  const [reviewIndex, setReviewIndex] = useState(0);
  const [camState, setCamState] = useState<CameraState>('requesting');
  const [camErrorKind, setCamErrorKind] = useState<
    'denied' | 'missing' | 'overconstrained' | 'unavailable'
  >('unavailable');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  /** All video inputs enumerated after permission (labels need permission). */
  const [cameras, setCameras] = useState<Array<{ deviceId: string; label: string }>>([]);
  /** Explicit device choice; ''/null = default (facingMode ideals). */
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(() =>
    initialCameraChoice(),
  );
  /** One-tap upgrade when a probed back camera is clearly sharper (>25%). Never auto-switches. */
  const [suggestedDeviceId, setSuggestedDeviceId] = useState<string | null>(null);
  const [mirrored, setMirrored] = useState(true);
  const [torchOn, setTorchOn] = useState(false);
  /** Honest flash note for transient torch failures (toggle stays mounted). */
  const [torchNote, setTorchNote] = useState<string | null>(null);
  // Visible unless hard-unsupported: inconclusive capabilities (no
  // getCapabilities, throws, or no `torch` field) default to SHOWING the
  // flash toggle — only an explicit `torch: false` (or a failed
  // applyConstraints) hides it.
  const [torchSupported, setTorchSupported] = useState(true);
  const [paused, setPaused] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  /** Exact-device fallback note surfaced adjacent to the camera select (top chrome). */
  const [deviceFallbackNote, setDeviceFallbackNote] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [redetecting, setRedetecting] = useState(false);
  /** Manual (default) vs self-timed stability shutter. Manual NEVER auto-fires. */
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  /**
   * Dev-only capture-quality toggle (More sheet): Max detail (default) vs
   * Fast bare capture. Initialized from the same `folio-bare-capture`
   * localStorage flag the shutter reads per-capture; no other store.
   */
  const [bareCapture, setBareCapture] = useState<boolean>(() => readBareCaptureFlag());
  /**
   * Overflow sheet (More): flash, flip, mirror, camera select, capture
   * mode, and import all live here so the finder stays clean. The sheet
   * panel stays mounted while closed (hooks hold, nothing unmounts).
   */
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * Visited tracking (implicit-accept progress): viewing a page marks it
   * visited. `visitedTick` forces a rerender when the set grows (refs don't
   * render by themselves); progress = visited count of remaining pages.
   */
  const visitedIdsRef = useRef(new Set<number>());
  const [, setVisitedTick] = useState(0);
  /**
   * Eager-warp bookkeeping: which corner quad each entry's `warpedUrl` was
   * built for (`lastWarpedQuadRef`), and which quads an eager warp was
   * already attempted for (`eagerAttemptRef`, set synchronously before the
   * async warp so a re-render mid-warp cannot fire a duplicate). Both guard
   * the eager effect against re-warp loops; neither changes any decision.
   */
  const lastWarpedQuadRef = useRef(new Map<number, string>());
  const eagerAttemptRef = useRef(new Map<number, string>());

  const idRef = useRef(0);
  const entriesRef = useRef<QueueEntry[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * Retained video node: React clears host refs (`videoRef`) before passive
   * unmount cleanups flush, so an unmount cleanup that reads `videoRef`
   * can never reach the node to drop its stream binding. This mirror keeps
   * the last attached node until the detach callback itself releases it —
   * detach (unmount or phase leave) is the reliable disconnect moment.
   */
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const setVideoEl = useCallback((el: HTMLVideoElement | null) => {
    if (el !== null) {
      videoRef.current = el;
      videoElRef.current = el;
      return;
    }
    const prev = videoElRef.current;
    videoRef.current = null;
    videoElRef.current = null;
    // Still holding the node: drop the stream binding now (tracks are
    // stopped by stopTracks on the same paths).
    if (prev !== null) prev.srcObject = null;
  }, []);
  const streamRef = useRef<MediaStream | null>(null);
  /** Session ref mirror of the camera choice (survives effect remounts within the session). */
  const chosenDeviceIdRef = useRef<string | null>(initialCameraChoice());
  /** Best-camera probe guards: fire once per mount, generation-checked (StrictMode-safe). */
  const probeFiredRef = useRef(false);
  const probeGenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  /**
   * Scan worker clients: detection runs on the mount-lifetime retained client
   * (warm ORT session, released on unmount only) plus per-drain pool-owned
   * lanes; warps use a SEPARATE owned client so an Apply-time warp cancel
   * (terminate on the warp client) can never nuke another entry's in-flight
   * detection. Warp pixels are always decoded fresh from the original File —
   * no decoded element/image cache is retained past any operation (the old
   * `imageElsRef` is gone: nothing outlives detection+warp).
   */
  const warpClientRef = useRef<ScanicClient | null>(null);
  /**
   * Review-drain detect pool (retained lane 0 + owned lanes — see
   * `acquireDetectionPool`). `releaseOwned()` frees owned lanes on drain
   * completion, drain cancel, discard, and unmount; the retained lane
   * survives until `releaseRetainedDetectClient()` on unmount below.
   */
  const detectPoolRef = useRef<DetectionPool | null>(null);
  /** Review-drain generation: cancel bumps it so stale continuations drop. */
  const drainGenRef = useRef(0);
  /**
   * Entries a drain already picked up: `goToReview` starts detection once
   * per queued entry, so a second call (StrictMode/remount double-run)
   * never double-detects. Cleared on every cancel/discard-all.
   */
  const drainStartedRef = useRef(new Set<number>());
  /**
   * Per-entry warp generation: Apply spam bumps the seq and terminates that
   * entry's in-flight warp; stale continuations (wrong seq) drop silently so
   * only the latest quad's warp can commit. A `cancelled` warp whose seq is
   * still current (worker loss raced it) is never swallowed: it clears the
   * entry's eager attempt and schedules a visible retry so the page cannot
   * strand on "Processing auto-crop…".
   */
  const warpSeqRef = useRef(new Map<number, number>());
  /**
   * Per-entry in-flight warp marker (entry id → seq with a worker request
   * outstanding). Keyed by entry, never a shared seq set: two entries' seq
   * values collide (both start at 1), and a cross-entry terminate would
   * strand the victim with its eager attempt already spent.
   */
  const warpInflightRef = useRef(new Map<number, number>());
  /** Sync guard against double-tap Re-detect (entriesRef mirrors async). */
  const redetectingIdsRef = useRef(new Set<number>());
  /** Bumped to refire the eager warp after an interrupted attempt. */
  const [warpRetryTick, setWarpRetryTick] = useState(0);
  const warpedBlobsRef = useRef(new Map<number, Blob>());
  const objectUrlsRef = useRef(new Set<string>());
  /** Last shutter time (manual or auto) — the auto cooldown gates on this. */
  const lastFireRef = useRef<number | null>(null);
  /**
   * Shutter-inflight guard (F-22): `takePhoto(max)` can hold the camera
   * pipeline for hundreds of ms with zero UI feedback, so a second tap
   * queues a second `takePhoto` on the same track and the finder reads as
   * frozen. `capturing` flips synchronously on tap (pill + disabled
   * shutter paint before the first await yields) and drops in `finally`,
   * so overlapping taps no-op instead of serializing on the sensor.
   */
  const [capturing, setCapturing] = useState(false);
  // Option A (F-22 hybrid) provisional frame thumb: a video-frame grab shown
  // in the gallery ~50ms after tap while takePhoto holds the sensor (~860ms
  // measured). Preview-only artifact — never committed, never decoded;
  // cleared + revoked the moment the real entry parks in enqueueCapture.
  const [pendingShotUrl, setPendingShotUrl] = useState<string | null>(null);
  const pendingShotRef = useRef<string | null>(null);
  const capturingRef = useRef(false);
  /**
   * Per-track photo-capability cache: `getPhotoCapabilities()` is an async
   * round-trip that never changes for a live track, so pay it once per
   * track instead of once per tap.
   */
  const photoCapsRef = useRef(new Map<string, { imageWidth?: number; imageHeight?: number }>());
  /**
   * Captured-flash: the quiet finder pill flashes `Captured — keep shooting`
   * for CAPTURE_FLASH_MS after each queue-only shutter park, then returns to
   * quiet. Refs never render alone — the tick state repaints on set and on
   * expiry. Never blocks any action.
   */
  const captureFlashUntilRef = useRef(0);
  const [, setFlashTick] = useState(0);
  const flashCaptured = useCallback(() => {
    captureFlashUntilRef.current = Date.now() + CAPTURE_FLASH_MS;
    setFlashTick((t) => t + 1);
    window.setTimeout(() => {
      if (mountedRef.current) setFlashTick((t) => t + 1);
    }, CAPTURE_FLASH_MS + 50);
  }, []);

  const stopTracks = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    // Retained node: `videoRef` may already be detached (unmount), so read
    // the mirror that survives until the detach callback releases it.
    const video = videoElRef.current ?? videoRef.current;
    if (video) video.srcObject = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // F-22 shutter localize (dev-only spans, measure-only): a mount opens a
    // fresh timing session. Every mark below no-ops off dev hosts.
    resetCaptureSpans();
    return () => {
      mountedRef.current = false;
      // The camera dies with the mount: stop tracks + drop the video binding
      // so no live track outlives the scanner (phase-leave and tab-hide call
      // stopTracks too; unmount must not rely on them having run first).
      stopTracks();
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
      // Owned drain lanes die with the mount; the retained lane survives
      // until the explicit release below (never terminated by a drain).
      // In-flight requests reject and their continuations drop on the
      // mountedRef check.
      try {
        detectPoolRef.current?.releaseOwned();
      } catch {
        // Release is best-effort; the reference is dropped regardless.
      }
      detectPoolRef.current = null;
      releaseRetainedDetectClient();
      warpClientRef.current?.terminate();
      warpClientRef.current = null;
    };
  }, [stopTracks]);

  /**
   * Mount-lifetime retained detect client for single detection (Re-detect).
   * Warm ORT session reused across drains; released on unmount above — never
   * on drain cancel. The review drain owns its own pool (`detectPoolRef`)
   * whose lane 0 is this same client instead.
   */
  const getScanClient = useCallback((): ScanicClient => getRetainedDetectClient(), []);

  /**
   * Lazily-created owned scan worker client for warps. Separate from
   * detection so Apply-time terminate-to-cancel only ever cancels warps.
   */
  const getWarpClient = useCallback((): ScanicClient => {
    if (warpClientRef.current === null) warpClientRef.current = new ScanicClient();
    return warpClientRef.current;
  }, []);

  // Full-screen takeover: lock body scroll while the scanner is mounted so
  // the in-page document never scrolls behind the fixed surface.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Ref mirror: decisions schedule phase transitions AFTER setEntries, so the
  // updaters themselves stay pure (StrictMode double-invokes updaters).
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const trackUrl = useCallback((url: string): string => {
    objectUrlsRef.current.add(url);
    return url;
  }, []);
  const revokeUrl = useCallback((url: string | null) => {
    if (url !== null && objectUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  /* Queue derived state: discarded entries leave the queue immediately;
     implicit accept means every remaining page builds (no pending). */
  const queue = entries;
  const accepted = queue;
  const safeIndex = queue.length === 0 ? 0 : Math.min(reviewIndex, queue.length - 1);
  const current = queue[safeIndex] ?? null;
  const visitedCount = queue.filter((e) => visitedIdsRef.current.has(e.id)).length;
  // Front-camera preview is mirrored by default (industry standard); the back
  // camera is never mirrored. Captured frames ignore this entirely (see
  // captureFrame: takePhoto is sensor-native = unmirrored; the canvas
  // fallback drawImage reads raw pixels, never the CSS transform).
  const previewMirrored = facing === 'user' && mirrored;

  /* ---------------- detection (ML only, worker) ---------------- */

  /**
   * Full-frame miss note (shared by the review drain and the single-entry
   * Re-detect path below — one string, one settle semantic).
   */
  const FULL_FRAME_MISS_NOTE =
    'Auto-detect found no page — the full frame will be used. Adjust corners to crop manually.';

  /**
   * Dev-only detection telemetry (never UI): detector + confidence + input
   * dims plus the ML lane's `instrumentation {decodeMs, transferBytes,
   * ortLoadMs, sessionCreateMs, inferenceMs, confidence, inputWidth,
   * inputHeight, modelInputSize}`, the read-only EXIF probe, and the
   * per-item queue wall span. Measure-only: `extra` never changes detection
   * behavior, never gates thresholds, never touches resolution/decode.
   */
  const logDetectTelemetryDev = useCallback(
    (
      dims: { w: number; h: number },
      result: { confidence: number | null; detector: string } & {
        instrumentation?: ScanicDetectInstrumentation | undefined;
      },
      extra?: {
        decodeMs?: number | null;
        exif?: ExifProbeResult | null;
        spanMs?: number | null;
      },
    ) => {
      if (import.meta.env.DEV) {
        const inst = result.instrumentation;
        const instPart =
          inst !== undefined && inst !== null
            ? ` decodeMs=${inst.decodeMs} transferBytes=${inst.transferBytes} ortLoadMs=${inst.ortLoadMs} sessionCreateMs=${inst.sessionCreateMs} inferenceMs=${inst.inferenceMs} modelInputSize=${inst.modelInputSize}`
            : ' instrumentation=missing';
        const decodePart =
          extra?.decodeMs !== undefined && extra?.decodeMs !== null
            ? ` decodeWallMs=${extra.decodeMs}`
            : '';
        const exifPart =
          extra?.exif !== undefined && extra?.exif !== null
            ? ` exifOrientation=${extra.exif.orientation} hasExif=${extra.exif.hasExif}`
            : '';
        const spanPart =
          extra?.spanMs !== undefined && extra?.spanMs !== null ? ` spanMs=${extra.spanMs}` : '';
        console.debug(
          `[scan-detect] detector=${result.detector} confidence=${result.confidence} input=${dims.w}x${dims.h}${instPart}${decodePart}${exifPart}${spanPart}`,
        );
      }
    },
    [],
  );

  /**
   * Enqueues an untouched original File WITHOUT any detection work. The
   * entry parks `queued` with its photo thumb — no decode, no worker, no
   * `detectEntry` call — so the shutter (manual, auto, file fallback) stays
   * instant. ML detection is deferred to the review drain. Returns the
   * queue position (worker-hook seam: same name, same shape as
   * `./scan/index`).
   */
  const enqueueCapture = useCallback(
    (file: File): number => {
      const id = idRef.current + 1;
      idRef.current = id;
      // Option A: the real entry just parked — drop the provisional frame
      // thumb (revoked, never leaked; unmount sweeps tracked URLs anyway).
      const prev = pendingShotRef.current;
      pendingShotRef.current = null;
      if (prev !== null) {
        revokeUrl(prev);
        setPendingShotUrl(null);
      }
      let photoUrl = '';
      try {
        photoUrl = trackUrl(URL.createObjectURL(file));
      } catch {
        photoUrl = '';
      }
      const position = entriesRef.current.length;
      const next = [
        ...entriesRef.current,
        {
          id,
          original: file,
          photoUrl,
          imageWidth: 0,
          imageHeight: 0,
          corners: null,
          warpedUrl: null,
          status: 'queued' as const,
          decision: 'warped' as const,
          note: null,
        },
      ];
      entriesRef.current = next;
      setEntries(next);
      // Queue-only shutter: no decode, no worker, no finder busy state — but
      // the pill flashes once (actionable voice) so the tap reads as kept.
      flashCaptured();
      // F-22 shutter localize (dev-only spans): the untouched original is
      // parked. No-op off dev hosts; queue behavior untouched.
      markCaptureSpan('file-parked');
      markCaptureSpan('thumb-url');
      return position;
    },
    [trackUrl, flashCaptured, revokeUrl],
  );

  /**
   * Single-entry (Re-detect) path — the old `detectEntry` folded in here so
   * one settle semantic serves both callers: decode a fresh full-res copy,
   * run ML-only `detect` on the retained client, settle `ready` (corners
   * or honest full-frame). Statuses and notes are byte-identical to the old
   * path; the canonical fan-out stays `startReviewDrain` below. The EXIF
   * probe rides alongside decode as read-only evidence (never gates, never
   * touches decode); instrumentation + probe ride the dev telemetry path.
   */
  const redetectEntry = useCallback(
    async (entry: QueueEntry) => {
      // Sync double-tap guard (entriesRef mirrors setEntries async, so a
      // second tap can race the `detecting` settle below).
      if (redetectingIdsRef.current.has(entry.id)) return;
      // The review drain owns `queued`/`detecting` entries: Re-detect runs
      // only for settled pages, so it can never duplicate the drain's lane-0
      // detect for the same entry (the button stays disabled until ready).
      const snap = entriesRef.current.find((e) => e.id === entry.id);
      if (!snap || snap.status !== 'ready') return;
      redetectingIdsRef.current.add(entry.id);
      // Invalidate this entry's in-flight warp NOW (synchronous, before the
      // first await): its quad is stale the moment fresh corners land, and
      // only the post-redetect warp may commit. The warp worker itself is
      // NOT terminated — other entries' warps are never victims.
      warpSeqRef.current.set(entry.id, (warpSeqRef.current.get(entry.id) ?? 0) + 1);
      setRedetecting(true);
      setCardError(null);
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? { ...e, status: 'detecting' as const, note: 'Re-running on-device ML detection…' }
            : e,
        ),
      );
      try {
        let image: ImageData;
        let decodeMs: number | null = null;
        let exif: ExifProbeResult | null = null;
        try {
          const decodeStart =
            typeof performance !== 'undefined' && typeof performance.now === 'function'
              ? performance.now()
              : Date.now();
          image = await decodeFileToImageData(entry.original);
          const decodeEnd =
            typeof performance !== 'undefined' && typeof performance.now === 'function'
              ? performance.now()
              : Date.now();
          decodeMs = decodeEnd - decodeStart;
          // F-22 shutter localize (dev-only span): fresh full-res decode copy.
          markCaptureSpan('drain-decode');
          try {
            exif = await probeExifOrientation(entry.original);
          } catch {
            exif = null;
          }
        } catch {
          if (!mountedRef.current) return;
          setEntries((prev) =>
            prev.map((e) =>
              e.id === entry.id
                ? {
                    ...e,
                    imageWidth: 0,
                    imageHeight: 0,
                    status: 'ready' as const,
                    note: 'Could not decode this image — the full frame will be used.',
                  }
                : e,
            ),
          );
          return;
        }
        if (!mountedRef.current) return;
        const w = image.width;
        const h = image.height;
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entry.id
              ? { ...e, imageWidth: w, imageHeight: h, note: 'Loading on-device ML detector…' }
              : e,
          ),
        );
        try {
          // ML-only (D46): a null quad means the ML found no page, and the
          // entry settles croppable full-frame below. No guessed crops, ever.
          const result = await getScanClient().detect(
            image,
            DEFAULT_DETECTOR,
            decodeMs !== null ? { decodeMs } : undefined,
          );
          // F-22 shutter localize (dev-only span): single-entry ML detect done.
          markCaptureSpan('drain-detect');
          logDetectTelemetryDev({ w, h }, result, { decodeMs, exif });
          if (!mountedRef.current) return;
          if (result.corners !== null) {
            setEntries((prev) =>
              prev.map((e) =>
                e.id === entry.id
                  ? {
                      ...e,
                      status: 'ready' as const,
                      corners: result.corners,
                      note: null,
                    }
                  : e,
              ),
            );
            return;
          }
          setEntries((prev) =>
            prev.map((e) =>
              e.id === entry.id
                ? { ...e, status: 'ready' as const, corners: null, note: FULL_FRAME_MISS_NOTE }
                : e,
            ),
          );
        } catch {
          // Worker crash/unavailable: degrade to full-frame, honestly labelled.
          // An ML miss inside the worker lands here the same way.
          if (!mountedRef.current) return;
          setEntries((prev) =>
            prev.map((e) =>
              e.id === entry.id
                ? {
                    ...e,
                    status: 'ready' as const,
                    corners: null,
                    note: 'Auto-detect failed on this image — the full frame will be used.',
                  }
                : e,
            ),
          );
        }
      } finally {
        redetectingIdsRef.current.delete(entry.id);
        if (mountedRef.current) setRedetecting(false);
      }
    },
    [getScanClient, logDetectTelemetryDev],
  );

  /* ---------------- camera session ---------------- */

  /**
   * Camera picker choice: stops the old tracks immediately, persists the
   * pick in the session ref (+ module), and restarts the session effect with
   * `deviceId: { exact }`. The facing quick-flip stays alongside the picker.
   */
  const chooseCamera = useCallback(
    (deviceId: string | null) => {
      const next = deviceId === '' ? null : deviceId;
      persistedCameraDeviceId = next;
      chosenDeviceIdRef.current = next;
      setSelectedDeviceId(next);
      setCaptureError(null);
      setDeviceFallbackNote(null);
      // A stale ON across switches explains phantom flash behavior — every
      // camera change starts with the torch off and no stale note/suggestion.
      setTorchOn(false);
      setTorchNote(null);
      setSuggestedDeviceId(null);
      if (next === null) clearStoredCameraId();
      stopTracks();
    },
    [stopTracks],
  );

  useEffect(() => {
    if (phase !== 'camera' || paused) return;
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setCamState('insecure');
      return;
    }
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setCamErrorKind('unavailable');
      setCamState('unavailable');
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    setCamState('requesting');
    (async () => {
      // Orientation-honest ideals, chosen once per session start (never a
      // forced portrait crop on a landscape sensor — see
      // buildVideoConstraints). With an explicit device the facingMode hint
      // is omitted (exact selection conflicts with it on some browsers).
      const activeDeviceId = chosenDeviceIdRef.current ?? selectedDeviceId;
      const wanted = buildVideoConstraints(facing, activeDeviceId);
      const openStream = async (video: MediaTrackConstraints): Promise<MediaStream> =>
        navigator.mediaDevices.getUserMedia({ video, audio: false });
      try {
        let usedExactFallback = false;
        try {
          stream = await openStream(wanted);
        } catch (first) {
          // Exact-device failure: fall back to the facingMode ideals once,
          // honestly — the pick stays visibly selected with a fallback note
          // adjacent to the select (top chrome) plus the shutter-area
          // error, so the recovery never reads as "nothing happened".
          const hasExactPick =
            activeDeviceId !== null && activeDeviceId !== undefined && activeDeviceId !== '';
          const firstKind = classifyCameraError(first);
          if (hasExactPick && firstKind !== 'denied') {
            try {
              stream = await openStream(buildVideoConstraints(facing, null));
              usedExactFallback = true;
              if (!cancelled) {
                setCamErrorKind('overconstrained');
                setDeviceFallbackNote(
                  'That camera could not be opened — using the default camera instead.',
                );
                setCaptureError(
                  'That camera could not be opened — using the default camera instead. You can pick another camera above.',
                );
              }
            } catch {
              throw first;
            }
          } else if (firstKind === 'overconstrained') {
            // Landscape `min: 1280` floor over-constrained a low-res sensor:
            // retry once with ideals only (no floor), which cannot
            // over-constrain — ideals are pure hints.
            const relaxed: MediaTrackConstraints =
              activeDeviceId !== null && activeDeviceId !== undefined && activeDeviceId !== ''
                ? {
                    deviceId: { exact: activeDeviceId },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                  }
                : {
                    facingMode: { ideal: facing },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                  };
            stream = await openStream(relaxed);
          } else {
            throw first;
          }
        }
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        if (!usedExactFallback && !cancelled) {
          setDeviceFallbackNote(null);
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          try {
            await video.play();
          } catch {
            // Autoplay policy: the user taps the shutter; play resumes then.
          }
        }
        const track = stream.getVideoTracks()[0];
        // Continuous focus effort where available — silent no-op otherwise.
        try {
          await track?.applyConstraints({
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
          });
        } catch {
          // Unsupported on this browser/device — fixed focus still scans.
        }
        // Facing reconcile: read the LIVE stream settings (actual sensor
        // mode) for `facingMode` when exposed (labelless OEM ids defeat
        // label-sniffing on pick); the label regex on pick stays as the
        // fallback when facingMode is unexposed. The preview itself is
        // full-bleed `object-cover` with no ratio styling anywhere — the
        // layer crops, never stretches, so a landscape webcam renders
        // landscape instead of a blurry zoomed portrait crop.
        try {
          const settings = track?.getSettings?.() as
            { width?: number; height?: number; facingMode?: string } | undefined;
          // Reconcile facing from the live track when exposed (labelless OEM
          // ids defeat label-sniffing on pick); the label regex on pick stays
          // as the fallback when facingMode is unexposed.
          if (
            !cancelled &&
            (settings?.facingMode === 'user' || settings?.facingMode === 'environment')
          ) {
            setFacing(settings.facingMode);
          }
        } catch {
          // Settings unreadable — the full-bleed layer already avoids any
          // forced ratio, so there is nothing to correct.
        }
        // Camera choice: enumerate AFTER permission so labels are real
        // (before permission they are blank). Fallback names keep blank
        // labels usable; the ordered index disambiguates duplicates. The list
        // is exactly what the platform exposes (logical cameras only — never
        // a fabricated physical-lens entry).
        try {
          const enumerate = navigator.mediaDevices.enumerateDevices?.bind(navigator.mediaDevices);
          if (typeof enumerate === 'function' && !cancelled) {
            const devices = await enumerate();
            if (!cancelled) {
              const videos = devices
                .filter((d) => d.kind === 'videoinput')
                .map((d) => ({
                  deviceId: d.deviceId ?? '',
                  label: (d.label ?? '').trim(),
                }))
                .filter((d) => d.deviceId !== '');
              setCameras(videos);
              // Validate a stored pick against the current enumeration: a
              // stale id (not listed) falls back to the default flow instead
              // of sticking on a missing device.
              const hasExactPick =
                activeDeviceId !== null && activeDeviceId !== undefined && activeDeviceId !== '';
              if (hasExactPick && videos.length > 0) {
                const stillListed = videos.some((v) => v.deviceId === activeDeviceId);
                if (!stillListed) {
                  persistedCameraDeviceId = null;
                  chosenDeviceIdRef.current = null;
                  clearStoredCameraId();
                  setSelectedDeviceId(null);
                }
              }
            }
          }
        } catch {
          // Enumeration failure leaves the facing quick-flip working.
        }
        let supportsTorch = true;
        try {
          const caps = track?.getCapabilities?.() as
            (MediaTrackCapabilities & { torch?: boolean }) | undefined;
          // Hard-unsupported ONLY when the track explicitly reports
          // `torch: false`. Missing API, throws, or a caps object without
          // the torch field is inconclusive — keep the toggle visible.
          // A transient applyConstraints({torch}) failure later must NEVER
          // hide the toggle either (honest note instead) — see toggleTorch.
          if (caps && 'torch' in caps) {
            supportsTorch = caps?.torch === true;
          } else {
            supportsTorch = true;
          }
        } catch {
          supportsTorch = true;
        }
        if (!cancelled) {
          setTorchSupported(supportsTorch);
          // Every camera change starts torch-off (stale ON explains phantom
          // behavior) with no stale flash note.
          setTorchOn(false);
          setTorchNote(null);
          // Persist the eventual pick on every successful exact-device start;
          // the session ref already wins within the session.
          if (
            !usedExactFallback &&
            activeDeviceId !== null &&
            activeDeviceId !== undefined &&
            activeDeviceId !== ''
          ) {
            persistedCameraDeviceId = activeDeviceId;
            chosenDeviceIdRef.current = activeDeviceId;
            writeStoredCameraId(activeDeviceId);
          }
          setCamState('live');
        }
      } catch (e) {
        if (cancelled) return;
        const kind = classifyCameraError(e);
        // Persistent OverconstrainedError against an exact stored pick:
        // reaching here with an exact pick means BOTH the exact-device open
        // AND the default-camera fallback failed constraint resolution, so
        // the saved deviceId is implicated in a failure loop — drop it
        // (session + storage + state) so the next open starts from defaults
        // instead of re-failing. The state reset re-runs this effect once
        // with defaults; a repeated failure there lands here with no exact
        // pick and stops (no retry loop).
        const failedPick = chosenDeviceIdRef.current ?? selectedDeviceId;
        if (
          kind === 'overconstrained' &&
          failedPick !== null &&
          failedPick !== undefined &&
          failedPick !== ''
        ) {
          persistedCameraDeviceId = null;
          chosenDeviceIdRef.current = null;
          clearStoredCameraId();
          setSelectedDeviceId(null);
        }
        setCamErrorKind(kind);
        if (kind === 'denied') setCamState('denied');
        else setCamState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        if (streamRef.current === stream) streamRef.current = null;
        // Disconnect path: drop the video binding when the detached stream
        // is the attached one, so no stopped track lingers on the element.
        const video = videoElRef.current ?? videoRef.current;
        if (video && video.srcObject === stream) video.srcObject = null;
      }
    };
  }, [phase, facing, selectedDeviceId, paused, retryNonce]);

  /**
   * Best-camera background probe: after the DEFAULT stream is live,
   * fire-and-forget probe every other enumerated device for max photo
   * resolution (never a constraint — focalLength never shipped). Each
   * candidate opens video-only (`deviceId: { exact }`, muted, never attached
   * to any element), resolves `ImageCapture.getPhotoCapabilities()` max
   * pixels (fallback: track `getCapabilities()` width×height max) plus the
   * PTZ zoom signal, scores via `scoreBackCamera` (ultra-wide/macro label
   * penalty, zoom bonus, megapixel tiebreak), then stops its tracks
   * immediately. The highest SCORE wins the default back-camera choice, gated
   * by a clearly-sharper pixel rule (>25% more pixels) — a one-tap
   * `[data-camera-suggest]` note, never an auto-switch. Skipped when
   * <2 cameras are listed, on any error, or once the user has picked (the
   * persisted pick wins overall). StrictMode-safe: `probeFiredRef` is set
   * inside the timer callback (never before it), so the double-effect
   * cleanup — which clears the first timer — cannot poison the remount's
   * probe; the generation guard drops any late double-mount result.
   */
  useEffect(() => {
    if (phase !== 'camera' || paused) return;
    if (camState !== 'live') return;
    if (cameras.length < 2) return;
    const activePick = chosenDeviceIdRef.current ?? selectedDeviceId;
    if (activePick !== null && activePick !== '') return;
    if (probeFiredRef.current) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    // F-22: never contend with shooting — the probe opens every other
    // camera one by one, which can stall the live track on phones. Skip
    // once the user is already capturing, and start 600ms past live so the
    // mount burst and the first tap never race it.
    if (entriesRef.current.length > 0 || capturingRef.current) return;
    const gen = (probeGenRef.current += 1);
    let alive = true;
    const timer = window.setTimeout(() => {
      if (!alive || probeGenRef.current !== gen) return;
      if (entriesRef.current.length > 0 || capturingRef.current) return;
      if (probeFiredRef.current) return;
      probeFiredRef.current = true;
      void (async () => {
        try {
          const liveTrack = streamRef.current?.getVideoTracks()[0] ?? null;
          if (!liveTrack) return;
          const currentPixels = await maxPixelsForTrack(liveTrack);
          if (currentPixels === null) return;
          const currentLabel =
            typeof (liveTrack as { label?: unknown }).label === 'string'
              ? ((liveTrack as { label?: string }).label ?? '')
              : '';
          const currentHasZoom = await hasZoomForTrack(liveTrack);
          const currentScore = scoreBackCamera({
            label: currentLabel,
            maxPixels: currentPixels,
            hasZoom: currentHasZoom,
          });
          // Default stream's device is unknown, so every listed input is a
          // candidate; with an explicit pick this effect never runs (guarded).
          const candidates = cameras.filter((c) => c.deviceId !== '' && c.deviceId !== activePick);
          if (candidates.length === 0) return;
          let bestId: string | null = null;
          let bestPixels = 0;
          let bestScore = Number.NEGATIVE_INFINITY;
          for (const candidate of candidates) {
            if (!alive || probeGenRef.current !== gen) return;
            let probeStream: MediaStream | null = null;
            try {
              probeStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: candidate.deviceId } },
                audio: false,
              });
              const probeTrack = probeStream.getVideoTracks()[0];
              if (!probeTrack) continue;
              const pixels = await maxPixelsForTrack(probeTrack);
              if (pixels === null) continue;
              const hasZoom = await hasZoomForTrack(probeTrack);
              const score = scoreBackCamera({
                label: candidate.label ?? '',
                maxPixels: pixels,
                hasZoom,
              });
              if (score > bestScore) {
                bestScore = score;
                bestPixels = pixels;
                bestId = candidate.deviceId;
              }
            } catch {
              // Unopenable candidate — try the next one.
              continue;
            } finally {
              try {
                if (probeStream) for (const t of probeStream.getTracks()) t.stop();
              } catch {
                // Stop is best-effort.
              }
            }
          }
          if (!alive || probeGenRef.current !== gen) return;
          if (!mountedRef.current) return;
          // Still on the default pick? Never auto-switch — suggest only.
          const stillDefault =
            (chosenDeviceIdRef.current ?? selectedDeviceId) === null ||
            (chosenDeviceIdRef.current ?? selectedDeviceId) === '';
          if (!stillDefault) return;
          if (bestId !== null && bestPixels > currentPixels * 1.25 && bestScore > currentScore) {
            setSuggestedDeviceId(bestId);
          }
        } catch {
          // Probe is advisory — any failure stays silent.
        }
      })();
    }, 600);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [phase, paused, camState, cameras, selectedDeviceId]);

  // Leaving the camera view (review/done) releases the camera; returning resumes.
  useEffect(() => {
    if (phase !== 'camera') {
      stopTracks();
      setTorchOn(false);
    }
  }, [phase, stopTracks]);

  // Tab-hidden pause: stop tracks while hidden, resume on visible.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.hidden) {
        stopTracks();
        setPaused(true);
      } else {
        setPaused(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stopTracks]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
      setTorchNote(null);
    } catch {
      // Transient failure: NEVER unmount the toggle — keep it visible with an
      // honest note. Only `torch: false` capabilities (above) may hide it.
      setTorchNote("Flash isn't available on this camera");
    }
  }, [torchOn]);

  /**
   * Option A (F-22 hybrid) provisional thumb: draws the live preview frame
   * into a small JPEG (~50ms) so the tap reads as kept while takePhoto holds
   * the sensor. Preview-only — never committed, never decoded, replaced by
   * the real queued entry on resolve. Any failure (no video frame, no 2D
   * canvas, no toBlob) resolves to silent null: the shutter behaves exactly
   * as before, thumb landing with the park. Never delays takePhoto: the
   * encode callback settles on its own, guarded by the inflight flag.
   */
  const grabProvisionalThumb = useCallback(() => {
    try {
      const v = videoRef.current;
      if (!v || v.videoWidth === 0 || v.videoHeight === 0) return;
      const scale = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(v.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(v.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      if (typeof canvas.toBlob !== 'function') return;
      canvas.toBlob(
        (b) => {
          if (!b || !mountedRef.current || !capturingRef.current) return;
          try {
            const url = trackUrl(URL.createObjectURL(b));
            pendingShotRef.current = url;
            setPendingShotUrl(url);
          } catch {
            // Preview-only: never fail the shutter.
          }
        },
        'image/jpeg',
        0.7,
      );
    } catch {
      // Preview-only: any platform gap falls back to today's behavior.
    }
  }, [trackUrl]);

  /**
   * Original-blob shutter: the ImageCapture API returns the sensor's native
   * Blob (`takePhoto()`) — zero canvas, zero toBlob, zero re-encode, no
   * quality param. takePhoto output is sensor-native and therefore
   * UNMIRRORED by construction (the front-preview `scaleX(-1)` is CSS-only
   * and never reaches the sensor path), preserving the mirror invariant.
   * Resolution requests the `getPhotoCapabilities()` max when the browser
   * exposes it (best original); otherwise the bare native default.
   * Canvas-draw is a fallback ONLY when ImageCapture is unavailable or
   * `takePhoto()` throws (older browsers, virtual cameras) — commented at
   * the branch, same unmirrored `drawImage` semantics as before.
   *
   * Experiment B (F-22) bare-capture switch: `localStorage["folio-bare-capture"]
   * === "1"` skips the max request and calls bare `takePhoto()` (sensor-native
   * default) so the phone can compare max-res vs native-default with measured
   * evidence. Default OFF — absent or any other value keeps the byte-identical
   * max path. Read once per capture (never cached across sessions); harmless
   * on prod (default off; the dev-gated spans module already gates by host).
   */
  const captureFrame = useCallback(async () => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    setCapturing(true);
    // F-22 shutter localize (dev-only spans): shutter fired + the Capturing…
    // pill state requested. No-op off dev hosts; capture behavior untouched.
    markCaptureSpan('tap');
    markCaptureSpan('pill');
    // Option A: provisional frame thumb fires sync here — it never awaits
    // takePhoto, so the gallery shows the tap in ~50ms, not ~860ms.
    grabProvisionalThumb();
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0] ?? null;
    setCaptureError(null);
    try {
      if (!track || track.readyState === 'ended') {
        setCaptureError('Camera is not ready yet — wait for the preview, then try again.');
        return;
      }
      const ImageCaptureCtor = getImageCaptureCtor();
      if (ImageCaptureCtor) {
        try {
          const capture = new ImageCaptureCtor(track);
          // Experiment B (F-22) bare-capture switch, read once per capture:
          // "1" takes the sensor-native default (bare takePhoto, no max
          // request). Anything else (absent/invalid/unreadable storage) is
          // OFF — the byte-identical max path below.
          let bareCapture = false;
          try {
            bareCapture = globalThis.localStorage?.getItem('folio-bare-capture') === '1';
          } catch {
            bareCapture = false;
          }
          const trackKey =
            typeof (track as { id?: unknown }).id === 'string'
              ? (track as { id: string }).id
              : 'default';
          // Bare mode skips the per-track cache read too: a cached max from
          // an earlier OFF capture on this track must never leak into a bare
          // capture.
          let photoSettings: { imageWidth?: number; imageHeight?: number } | undefined = bareCapture
            ? undefined
            : photoCapsRef.current.get(trackKey);
          if (!bareCapture && photoSettings === undefined) {
            try {
              if (typeof capture.getPhotoCapabilities === 'function') {
                const caps = await capture.getPhotoCapabilities();
                const maxW = caps.imageWidth?.max;
                const maxH = caps.imageHeight?.max;
                if (typeof maxW === 'number' && typeof maxH === 'number') {
                  photoSettings = { imageWidth: maxW, imageHeight: maxH };
                  photoCapsRef.current.set(trackKey, photoSettings);
                  // F-22 shutter localize: the caps round-trip was paid (cached
                  // tracks skip this — honestly, no fetch, no span).
                  markCaptureSpan('caps');
                }
              }
            } catch {
              // Capabilities unreadable — fall through to the native default.
              photoSettings = undefined;
            }
          }
          // F-22 shutter localize: the sensor hold, start to blob in hand.
          markCaptureSpan('takePhoto-start');
          // Experiment B: single unambiguous line when bare mode fires (the
          // dev-gated spans module has no `bare` detail seam — see follow-up
          // in the task report — so the phone console carries the mode).
          if (bareCapture) {
            console.info('[scan-capture] bare takePhoto (experiment B: no photoSettings)');
          }
          const blob =
            photoSettings !== undefined
              ? await capture.takePhoto(photoSettings)
              : await capture.takePhoto();
          markCaptureSpan('takePhoto-end');
          if (!mountedRef.current) return;
          if (!blob || blob.size === 0) throw new Error('empty photo');
          // Untouched original from here on: the queue never re-encodes it.
          const file = new File([blob], `capture-${idRef.current + 1}.jpg`, {
            type: blob.type || 'image/jpeg',
          });
          enqueueCapture(file);
          return;
        } catch {
          // takePhoto rejected (virtual camera, insecure pipe, in-use track) —
          // fall through to the canvas-draw fallback below, which reads the
          // live <video> frame instead of the sensor still.
        }
      }
      // Fallback ONLY: ImageCapture unavailable or takePhoto threw on this
      // browser/device. Reads raw camera pixels (never the CSS mirror), at the
      // preview's native frame size — no upscale, no quality param beyond the
      // legacy JPEG container this path historically produced.
      if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
        setCaptureError('Camera is not ready yet — wait for the preview, then try again.');
        return;
      }
      try {
        await video.play().catch(() => undefined);
      } catch {
        // Play failure still leaves the last frame drawable in most browsers.
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setCaptureError(
          'Could not read a camera frame on this browser — add an image file instead.',
        );
        return;
      }
      // Unmirrored invariant: drawImage reads raw camera pixels, never the CSS
      // `scaleX(-1)` preview transform — captures are always true-to-scene.
      ctx.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          if (typeof canvas.toBlob !== 'function') {
            resolve(null);
            return;
          }
          canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
        } catch {
          resolve(null);
        }
      });
      if (!mountedRef.current) return;
      if (!blob) {
        setCaptureError('Could not capture a frame — try again or add an image file instead.');
        return;
      }
      // Untouched original from here on: the queue never re-encodes it.
      const file = new File([blob], `capture-${idRef.current + 1}.jpg`, { type: 'image/jpeg' });
      enqueueCapture(file);
    } finally {
      capturingRef.current = false;
      if (mountedRef.current) setCapturing(false);
    }
  }, [enqueueCapture, grabProvisionalThumb]);

  /** Shutter tap: records the fire time so auto mode never double-fires. */
  const manualCapture = useCallback(() => {
    lastFireRef.current = Date.now();
    void captureFrame();
  }, [captureFrame]);

  // Auto capture: SAD-based stability shutter over tiny downscaled preview
  // frames. Armed ONLY in auto mode on the live camera view — manual mode
  // never reaches the sampler, so it can never auto-fire. Static previews
  // (SAD 0) count as steady but stay cooldown-bounded like any other fire.
  useEffect(() => {
    if (phase !== 'camera' || mode !== 'auto' || camState !== 'live') return;
    let cancelled = false;
    let prev: Uint8Array | null = null;
    let stable = 0;
    const id = window.setInterval(() => {
      if (cancelled || document.hidden) return;
      if (capturingRef.current) return;
      const video = videoRef.current;
      if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
      const gray = samplePreviewGrayscale(video);
      if (!gray) return;
      if (prev !== null) {
        const sad = grayscaleSAD(prev, gray);
        stable = isStableFrame(sad, gray.length) ? stable + 1 : 0;
        if (shouldAutoFire(stable, Date.now(), lastFireRef.current)) {
          lastFireRef.current = Date.now();
          stable = 0;
          void captureFrame();
        }
      }
      prev = gray;
    }, AUTO_CAPTURE_TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phase, mode, camState, captureFrame]);

  // Keyboard: Space fires the shutter on the live camera view (unless focus
  // sits on an interactive control, where native activation already covers
  // it, or the sheet is open); Esc closes the sheet first, else steps back
  // (review/done → camera) or exits (camera → onExit).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (sheetOpen) {
          e.preventDefault();
          setSheetOpen(false);
        } else if (phase === 'camera') {
          e.preventDefault();
          onExit();
        } else {
          e.preventDefault();
          setPhase('camera');
        }
        return;
      }
      if (phase !== 'camera' || e.code !== 'Space') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? '';
      if (/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(tag) || t?.isContentEditable === true) return;
      if (sheetOpen || camState !== 'live') return;
      e.preventDefault();
      lastFireRef.current = Date.now();
      void captureFrame();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, sheetOpen, camState, captureFrame, onExit]);

  // The sheet belongs to the camera phase: leaving it parks the sheet
  // closed so returning to the camera always reopens on a clean finder.
  useEffect(() => {
    if (phase !== 'camera') setSheetOpen(false);
  }, [phase]);

  const addFilesInstead = useCallback(
    (files: File[]) => {
      const images = files.filter(
        (f) => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name),
      );
      for (const file of images) enqueueCapture(file);
    },
    [enqueueCapture],
  );

  /* ---------------- review verdicts (implicit accept, toggle only) ---------------- */

  /* ---------------- deferred review drain (ML runs here, never on shutter) ---------------- */

  /**
   * Releases the review-drain pool's OWNED lanes and invalidates its
   * generation so every in-flight continuation drops. The retained lane
   * (pool lane 0) is never terminated here — only `releaseOwned()` runs.
   * Also clears the once-per-entry guard so a later review re-drains
   * whatever is still queued.
   */
  const cancelDrainPool = useCallback(() => {
    drainGenRef.current += 1;
    const pool = detectPoolRef.current;
    detectPoolRef.current = null;
    drainStartedRef.current.clear();
    try {
      pool?.releaseOwned();
    } catch {
      // Release is best-effort; the reference is dropped regardless.
    }
  }, []);

  /**
   * Deferred ML detection for every queued entry, fanned out over
   * `resolveDetectionWorkerCount({ pageCount: pending.length })` lanes
   * (PENDING count — a revisit with 1 undetected page stays serial) via
   * `runReviewDetectionQueue` stride lanes. Lanes are staffed by
   * `acquireDetectionPool` (lane 0 = retained warm client) and indexed by
   * `detectionLaneClient` (direct, no modulo). Each entry decodes a fresh
   * full-resolution ImageData COPY of its original (single-use — the worker
   * neuters it; nothing decoded is cached) and settles `ready` with corners,
   * or `ready` full-frame with the honest note on a miss or any failure
   * (never throws to the UI). The EXIF probe rides alongside decode as
   * read-only evidence; instrumentation + probe + per-item spans ride the
   * dev telemetry path (measure-only). Idempotent per entry via
   * `drainStartedRef` (StrictMode/remount-safe); a no-op when nothing is
   * queued.
   */
  const startReviewDrain = useCallback(async () => {
    const pending = entriesRef.current.filter(
      (e) => e.status === 'queued' && !drainStartedRef.current.has(e.id),
    );
    if (pending.length === 0) return;
    for (const e of pending) drainStartedRef.current.add(e.id);
    const gen = drainGenRef.current + 1;
    drainGenRef.current = gen;
    const workerCount = resolveDetectionWorkerCount({ pageCount: pending.length });
    const pool = acquireDetectionPool(workerCount, {});
    detectPoolRef.current = pool;
    const collector = createReviewSpanCollector<QueueEntry>();
    try {
      await runReviewDetectionQueue(pending, {
        workerCount: pool.clients.length,
        isCancelled: () => drainGenRef.current !== gen || !mountedRef.current,
        onItemSpan: collector.onItemSpan,
        process: async (entry, workerIndex) => {
          if (drainGenRef.current !== gen || !mountedRef.current) return;
          if (!entriesRef.current.some((e) => e.id === entry.id)) return;
          // F-22 shutter localize: 1-based page position for per-page spans.
          const pageNo = pending.indexOf(entry) + 1;
          setEntries((prev) =>
            prev.map((e) =>
              e.id === entry.id
                ? { ...e, status: 'detecting' as const, note: 'Loading on-device ML detector…' }
                : e,
            ),
          );
          let image: ImageData;
          let decodeMs: number | null = null;
          let exif: ExifProbeResult | null = null;
          try {
            const decodeStart =
              typeof performance !== 'undefined' && typeof performance.now === 'function'
                ? performance.now()
                : Date.now();
            image = await decodeFileToImageData(entry.original);
            const decodeEnd =
              typeof performance !== 'undefined' && typeof performance.now === 'function'
                ? performance.now()
                : Date.now();
            decodeMs = decodeEnd - decodeStart;
            // F-22 shutter localize (dev-only span): fresh full-res decode copy.
            markCaptureSpan('drain-decode', { n: pageNo });
            try {
              exif = await probeExifOrientation(entry.original);
            } catch {
              exif = null;
            }
          } catch {
            if (drainGenRef.current !== gen || !mountedRef.current) return;
            if (!entriesRef.current.some((e) => e.id === entry.id)) return;
            setEntries((prev) =>
              prev.map((e) =>
                e.id === entry.id
                  ? {
                      ...e,
                      imageWidth: 0,
                      imageHeight: 0,
                      status: 'ready' as const,
                      note: 'Could not decode this image — the full frame will be used.',
                    }
                  : e,
              ),
            );
            // F-22 shutter localize (dev-only span): page settled ready.
            markCaptureSpan('drain-commit', { n: pageNo });
            return;
          }
          if (drainGenRef.current !== gen || !mountedRef.current) return;
          if (!entriesRef.current.some((e) => e.id === entry.id)) return;
          const w = image.width;
          const h = image.height;
          setEntries((prev) =>
            prev.map((e) => (e.id === entry.id ? { ...e, imageWidth: w, imageHeight: h } : e)),
          );
          try {
            // ML-only (D46): a null quad means the ML found no page, and the
            // entry settles croppable full-frame below. No guessed crops, ever.
            const result = await detectionLaneClient(pool.clients, workerIndex).detect(
              image,
              DEFAULT_DETECTOR,
              decodeMs !== null ? { decodeMs } : undefined,
            );
            // F-22 shutter localize (dev-only span): drain ML detect done.
            markCaptureSpan('drain-detect', { n: pageNo });
            logDetectTelemetryDev({ w, h }, result, { decodeMs, exif });
            if (drainGenRef.current !== gen || !mountedRef.current) return;
            if (!entriesRef.current.some((e) => e.id === entry.id)) return;
            if (result.corners !== null) {
              setEntries((prev) =>
                prev.map((e) =>
                  e.id === entry.id
                    ? { ...e, status: 'ready' as const, corners: result.corners, note: null }
                    : e,
                ),
              );
              // F-22 shutter localize (dev-only span): page settled ready.
              markCaptureSpan('drain-commit', { n: pageNo });
              return;
            }
            setEntries((prev) =>
              prev.map((e) =>
                e.id === entry.id
                  ? { ...e, status: 'ready' as const, corners: null, note: FULL_FRAME_MISS_NOTE }
                  : e,
              ),
            );
            // F-22 shutter localize (dev-only span): page settled ready.
            markCaptureSpan('drain-commit', { n: pageNo });
          } catch {
            // Worker crash/unavailable/cancel-raced: degrade to full-frame,
            // honestly labelled. A cancelled generation drops above instead.
            if (drainGenRef.current !== gen || !mountedRef.current) return;
            if (!entriesRef.current.some((e) => e.id === entry.id)) return;
            setEntries((prev) =>
              prev.map((e) =>
                e.id === entry.id
                  ? { ...e, status: 'ready' as const, corners: null, note: FULL_FRAME_MISS_NOTE }
                  : e,
              ),
            );
            // F-22 shutter localize (dev-only span): page settled ready.
            markCaptureSpan('drain-commit', { n: pageNo });
          }
        },
      });
    } catch {
      // Cancelled drain (review cancel/discard/unmount): continuations
      // already drop on the generation guard; nothing to settle.
    }
    if (import.meta.env.DEV && collector.spans.length > 0) {
      console.debug(
        `[scan-detect] drain spans=${collector.spans.length} ` +
          collector.spans.map((s) => `lane${s.workerIndex}:${s.spanMs.toFixed(1)}ms`).join(' '),
      );
    }
    // This generation settled: release owned lanes (a later drain builds a
    // fresh pool; a superseding generation already replaced the ref). The
    // retained lane survives — never terminated here.
    if (drainGenRef.current === gen) {
      if (detectPoolRef.current === pool) detectPoolRef.current = null;
      try {
        pool.releaseOwned();
      } catch {
        // Best-effort only.
      }
    }
  }, [logDetectTelemetryDev]);

  /**
   * Preparing-overlay Cancel: stops the drain (owned lanes released,
   * generation invalidated), rolls interrupted `detecting` entries back to
   * `queued`, and returns to the camera. A later review re-drains them.
   */
  const cancelPreparing = useCallback(() => {
    cancelDrainPool();
    const next = entriesRef.current.map((e) =>
      e.status === 'detecting' ? { ...e, status: 'queued' as const, note: null } : e,
    );
    entriesRef.current = next;
    setEntries(next);
    setPhase('camera');
  }, [cancelDrainPool]);

  const goToReview = useCallback(
    (index?: number) => {
      setReviewIndex(index ?? 0);
      setPhase('review');
      void startReviewDrain();
    },
    [startReviewDrain],
  );

  /**
   * `Use original` toggle: flips the current page's render verdict between
   * warped (implicit accept, warped JPEG when available else original) and
   * original (byte-identical). Stays on the same page — no auto-advance.
   * StrictMode-safe: pure ref map + setEntries, no updater side effects.
   */
  const toggleVerdict = useCallback((id: number) => {
    const next: QueueEntry[] = entriesRef.current.map((e) =>
      e.id === id ? { ...e, decision: e.decision === 'original' ? 'warped' : 'original' } : e,
    );
    entriesRef.current = next;
    setEntries(next);
  }, []);

  /**
   * Re-warp after an adjust Apply (or any corner change): the fresh
   * `warpedUrl` re-renders the result preview reactively. The verdict stays
   * untouched (warped renders the fresh crop, original keeps the photo) —
   * no navigation, no decision change.
   *
   * Single warp per Apply: an Apply for a quad that already has a warp is a
   * no-op, and an Apply that lands while another warp is in flight bumps the
   * entry's generation and terminates the warp worker — the superseded warp
   * rejects as `cancelled` (or fails the generation check) and its
   * continuation drops silently, so only the latest quad's warp can commit.
   * The detection client is never touched: other entries keep detecting.
   */
  const rewrapEntry = useCallback(
    async (id: number, corners: ScanicCorners) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry) return;
      const quadKey = JSON.stringify(corners);
      if (lastWarpedQuadRef.current.get(id) === quadKey) return;
      const seq = (warpSeqRef.current.get(id) ?? 0) + 1;
      warpSeqRef.current.set(id, seq);
      // Cancel the ACTUAL in-flight warp for THIS entry only (eager or an
      // earlier Apply): terminate is skipped when this entry has no warp
      // request outstanding, so a lone warp never pays a worker re-init —
      // and another entry's warp is never a victim (its eager attempt stays
      // valid, so paging mid-warp cannot strand it). Detection is untouched.
      if (warpInflightRef.current.get(id) !== undefined) getWarpClient().terminate();
      setCardError(null);
      let image: ImageData;
      try {
        // Fresh full-res copy per warp: the worker transfers (neuters) the
        // pixels, and nothing decoded is retained between warps.
        image = await decodeFileToImageData(entry.original);
      } catch {
        if (mountedRef.current && warpSeqRef.current.get(id) === seq)
          setCardError('Warp failed on this page — nothing changed. Use the original instead.');
        return;
      }
      if (!mountedRef.current) return;
      if (warpSeqRef.current.get(id) !== seq) return;
      if (!entriesRef.current.some((e) => e.id === id)) return;
      warpInflightRef.current.set(id, seq);
      try {
        const warped = await getWarpClient().extract(image, corners);
        if (!mountedRef.current) return;
        if (warpSeqRef.current.get(id) !== seq) return;
        if (!entriesRef.current.some((e) => e.id === id)) return;
        const blob = await imageDataToJpeg(warped, 0.9);
        if (!blob) throw new Error('no jpeg');
        // F-22 shutter localize (dev-only span): warp render encoded.
        markCaptureSpan('drain-warp');
        if (!mountedRef.current) return;
        if (warpSeqRef.current.get(id) !== seq) return;
        if (!entriesRef.current.some((e) => e.id === id)) return;
        warpedBlobsRef.current.set(id, blob);
        revokeUrl(entriesRef.current.find((e) => e.id === id)?.warpedUrl ?? null);
        const url = trackUrl(URL.createObjectURL(blob));
        lastWarpedQuadRef.current.set(id, quadKey);
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, corners, warpedUrl: url } : e)),
        );
        // F-22 shutter localize (dev-only span): warp committed to the page.
        markCaptureSpan('drain-commit');
      } catch (error) {
        if (!mountedRef.current) return;
        // Superseded (a newer Apply — or a Re-detect — bumped the
        // generation): silent — the newer warp owns the outcome now.
        if (warpSeqRef.current.get(id) !== seq) return;
        if (!entriesRef.current.some((e) => e.id === id)) return;
        if (error instanceof ScanicClientError && error.code === 'cancelled') {
          // Interrupted but still current (worker loss raced the warp): never
          // swallow — clear the spent eager attempt and schedule a visible
          // retry so the page cannot strand on "Processing auto-crop…". The
          // retry re-enters through the eager effect (warpRetryTick), which
          // clears the note on start and commits on success.
          eagerAttemptRef.current.delete(id);
          setCardError('Auto-crop was interrupted — retrying…');
          setWarpRetryTick((t) => t + 1);
          return;
        }
        setCardError('Warp failed on this page — nothing changed. Use the original instead.');
      } finally {
        if (warpInflightRef.current.get(id) === seq) warpInflightRef.current.delete(id);
      }
    },
    [getWarpClient, revokeUrl, trackUrl],
  );

  const discardEntry = useCallback(
    (id: number) => {
      // A discard during the review drain stops it (owned lanes released,
      // generation invalidated) so no continuation can settle a removed
      // page; interrupted survivors roll back to `queued` and re-drain.
      cancelDrainPool();
      drainStartedRef.current.delete(id);
      const target = entriesRef.current.find((e) => e.id === id);
      if (target) {
        revokeUrl(target.photoUrl);
        revokeUrl(target.warpedUrl);
        warpedBlobsRef.current.delete(id);
        warpSeqRef.current.delete(id);
        warpInflightRef.current.delete(id);
        redetectingIdsRef.current.delete(id);
        lastWarpedQuadRef.current.delete(id);
        eagerAttemptRef.current.delete(id);
        visitedIdsRef.current.delete(id);
      }
      const removed = entriesRef.current.filter((e) => e.id !== id);
      const next = removed.map((e) =>
        e.status === 'detecting' ? { ...e, status: 'queued' as const, note: null } : e,
      );
      entriesRef.current = next;
      setEntries(next);
      setTimeout(() => {
        if (!mountedRef.current) return;
        if (next.length === 0) setPhase('camera');
        else setReviewIndex((i) => Math.min(i, next.length - 1));
      }, 0);
      if (next.some((e) => e.status === 'queued')) void startReviewDrain();
    },
    [revokeUrl, cancelDrainPool, startReviewDrain],
  );

  /**
   * Discard-all from the review batch bar: drops EVERYTHING back to the
   * camera, confirm-free. Revokes every queued URL so no blob leaks, and
   * stops the review drain (owned lanes released) so preparing clears.
   */
  const discardAll = useCallback(() => {
    cancelDrainPool();
    for (const entry of entriesRef.current) {
      revokeUrl(entry.photoUrl);
      revokeUrl(entry.warpedUrl);
      warpedBlobsRef.current.delete(entry.id);
    }
    warpSeqRef.current.clear();
    warpInflightRef.current.clear();
    redetectingIdsRef.current.clear();
    lastWarpedQuadRef.current.clear();
    eagerAttemptRef.current.clear();
    visitedIdsRef.current.clear();
    entriesRef.current = [];
    setEntries([]);
    setReviewIndex(0);
    setPhase('camera');
  }, [revokeUrl, cancelDrainPool]);

  /**
   * EAGER warp: the review single canvas needs a `warpedUrl` the moment a
   * page has corners. When the review shows a ready page with corners whose
   * quad has no warp yet, re-warp immediately via the verdict-free
   * `rewrapEntry` core — no verdict change, ML-first / null-fallback /
   * commit paths untouched. Loop guard: one attempt per (entry, quad); skip
   * when the current `warpedUrl` was already built for these exact corners.
   * Runs for both verdicts so toggling back to warped is instant. An
   * interrupted warp clears its attempt and bumps `warpRetryTick`, so the
   * retry re-enters here instead of stranding the page.
   */
  const eagerCornersKey = current?.corners ? JSON.stringify(current.corners) : null;
  useEffect(() => {
    if (phase !== 'review' || current === null || eagerCornersKey === null) return;
    if (current.status !== 'ready') return;
    if (current.corners === null) return;
    if (lastWarpedQuadRef.current.get(current.id) === eagerCornersKey) return;
    if (eagerAttemptRef.current.get(current.id) === eagerCornersKey) return;
    eagerAttemptRef.current.set(current.id, eagerCornersKey);
    void rewrapEntry(current.id, current.corners);
  }, [phase, current, eagerCornersKey, rewrapEntry, warpRetryTick]);

  /**
   * Visited marking: viewing a page (reviewIndex change incl. filmstrip tap,
   * pager buttons, and the initial show) marks it visited. Idempotent under
   * StrictMode double-effects (Set add is a no-op the second time, no tick).
   */
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (phase !== 'review' || currentId === null) return;
    if (visitedIdsRef.current.has(currentId)) return;
    visitedIdsRef.current.add(currentId);
    setVisitedTick((t) => t + 1);
  }, [phase, currentId, safeIndex]);

  /**
   * F-22 shutter localize (dev-only spans, measure-only): marks when the
   * camera strip re-renders with N queued pages. No-op off dev hosts;
   * render output untouched.
   */
  const stripQueueCount = queue.length;
  useEffect(() => {
    if (phase !== 'camera' || stripQueueCount === 0) return;
    markCaptureSpan('strip-rendered', { n: stripQueueCount });
  }, [phase, stripQueueCount]);

  /**
   * Commits the queue in capture order through `prepareImportFile`
   * normalization (the same import pixel budget gallery uploads run through,
   * so a 48MP sensor photo can't bypass it): warped verdicts commit their
   * warp JPEG, original verdicts (or warped verdicts with no warp yet)
   * commit the byte-identical original — renamed to `scan-NNN.jpg`, never
   * re-encoded in place. Normalization runs sequentially (one decode at a
   * time, the import memory bound) and any per-file failure falls back to
   * the candidate file, so the commit never loses a page. Warp blobs are
   * dropped on commit: the committed Files own the bytes from here on.
   */
  const buildPdf = useCallback(async () => {
    // F-22 shutter localize (dev-only spans): commit started.
    markCaptureSpan('build-start');
    const pages: ScanicCommittedPage[] = [];
    for (let i = 0; i < accepted.length; i += 1) {
      const entry = accepted[i];
      const name = formatScanName(startIndex + i);
      let candidate: File;
      if (entry.decision !== 'original') {
        const blob = warpedBlobsRef.current.get(entry.id);
        if (blob) candidate = new File([blob], name, { type: 'image/jpeg' });
        else
          candidate = new File([entry.original], name, {
            type: entry.original.type || 'image/jpeg',
          });
      } else {
        // Verdict `original`: the queued File, byte-identical — renamed,
        // never re-encoded (unless over the import pixel budget below).
        candidate = new File([entry.original], name, {
          type: entry.original.type || 'image/jpeg',
        });
      }
      try {
        const prepared = await prepareImportFile(candidate);
        const out =
          prepared.file instanceof File
            ? prepared.file
            : new File([prepared.file], prepared.name, { type: 'image/jpeg' });
        pages.push({ file: out, name: out.name });
      } catch {
        pages.push({ file: candidate, name });
      }
    }
    warpedBlobsRef.current.clear();
    // F-22 shutter localize: commit done — single console.table summary when
    // gated on (desktop debugging). No-op off dev hosts.
    markCaptureSpan('build-end');
    logCaptureSpansTable();
    onCommit(pages);
    onExit();
  }, [accepted, onCommit, onExit, startIndex]);

  const cameraHelp =
    camState === 'insecure'
      ? 'Camera needs a secure connection (HTTPS or localhost). You can add image files instead — they never leave this device.'
      : camState === 'denied'
        ? cameraFailureMessage('denied')
        : camState === 'unavailable'
          ? cameraFailureMessage(camErrorKind)
          : null;

  const lastQueued = queue.length === 0 ? null : queue[queue.length - 1];
  // Option A: provisional frame thumb wins until the real entry parks (never
  // counted as a page — it is preview-only until takePhoto resolves).
  const gallerySrc = pendingShotUrl ?? lastQueued?.photoUrl ?? null;

  /**
   * Preparing progress (review phase only): done = `ready` entries, total =
   * queue length. NON-BLOCKING: ready pages stay interactive under a slim
   * `[data-review-preparing]` banner (L-23 viewing-is-verdict) — the pager,
   * filmstrip, Add, and Next never gate on preparing. Pending thumbs carry
   * the … overlay until they settle `ready`; eager warp still waits for it.
   */
  const preparingTotal = queue.length;
  const preparingDone = queue.filter((e) => e.status === 'ready').length;
  const preparing = phase === 'review' && queue.length > 0 && preparingDone < preparingTotal;

  /**
   * ONE status pill, rendered ONLY when actionable (minimal finder — a quiet
   * Manual idle shows NO pill at all): the starting/paused/capturing states,
   * the 900ms captured flash, and the Auto-mode hold-steady hint; denied/retry
   * states come from `cameraHelp` below with the Import alternate, never a dead
   * end. No `Scanning…` branch, no dwell: the review preparing banner owns
   * the busy voice. (No dark-surface hint: detection is deferred to review,
   * so the camera phase has no brightness signal — inventing one would be
   * fake guidance.)
   */
  const finderPill: string | null =
    camState === 'requesting'
      ? 'Starting camera…'
      : paused
        ? 'Paused (tab hidden) — preview resumes when you return.'
        : capturing
          ? 'Capturing…'
          : Date.now() < captureFlashUntilRef.current
            ? 'Captured — keep shooting'
            : mode === 'auto'
              ? 'Hold steady over the page'
              : null;

  // Camera-phase flag: the camera is true full-bleed (video fills the
  // fixed surface edge-to-edge, chrome floats over it); review/done keep
  // the same overlay chrome (Close + title only — camera controls live in
  // the camera-phase sheet, never in review).
  const isCamera = phase === 'camera';

  // Review phase: the single-page card is owned by `./ScanicReview` (props
  // below stay EXACT minus the removed Looks-good reliance); the pager +
  // filmstrip + batch bar underneath are owned here because the review
  // component renders the card only (never duplicates).
  // Overflow sheet rows: every secondary camera control with a visible
  // label on a 44px row (L-24 label visibility lives here while the finder
  // stays clean). The panel stays mounted while closed (hooks hold, nothing
  // unmounts) — camera phase only; review/done chrome is Close + title.
  const sheetNote = 'px-3 py-1 text-center text-[11px] text-ink-500 dark:text-ink-300';
  const flipFacing = useCallback(() => {
    // Quick flip alongside the picker: clears any explicit
    // device pick (exact selection would otherwise ignore
    // facingMode) so the flip always takes effect.
    chooseCamera(null);
    setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
  }, [chooseCamera]);
  const pickCamera = useCallback(
    (id: string | null) => {
      // Keep the mirror semantics honest when the OS label
      // names a side: a picked front lens mirrors the
      // preview, a picked back lens never does. Unknown
      // labels leave the facing toggle untouched (the live
      // track's facingMode reconciles after start when
      // exposed).
      const picked = cameras.find((c) => c.deviceId === id);
      const lbl = (picked?.label ?? '').toLowerCase();
      if (id !== null && /front|user|facetime|selfie/.test(lbl)) setFacing('user');
      else if (id !== null && /back|rear|environment/.test(lbl)) setFacing('environment');
      chooseCamera(id);
    },
    [cameras, chooseCamera],
  );
  const cameraSheet = (
    <div className="flex max-h-[60dvh] flex-col gap-0.5 overflow-y-auto p-1.5">
      {torchSupported && (
        <SheetRowButton
          icon={torchOn ? '🔦' : '💡'}
          label="Flash"
          state={torchOn ? 'On' : 'Off'}
          ariaLabel="Toggle torch"
          pressed={torchOn}
          onClick={() => void toggleTorch()}
        />
      )}
      <SheetRowButton icon="⇄" label="Flip" ariaLabel="Switch camera" onClick={flipFacing} />
      <SheetRowButton
        icon={mirrored ? '◐' : '◑'}
        label="Mirror"
        state={facing !== 'user' ? 'Front only' : mirrored ? 'On' : 'Off'}
        ariaLabel="Mirror front-camera preview"
        title={
          facing !== 'user'
            ? 'Mirror applies to the front camera only'
            : mirrored
              ? 'Front preview mirrored (captures stay unmirrored)'
              : 'Front preview unmirrored'
        }
        pressed={mirrored}
        disabled={facing !== 'user'}
        dataAttr={{ 'data-mirror-toggle': '' }}
        onClick={() => setMirrored((v) => !v)}
      />
      {facing !== 'user' && (
        <p data-mirror-note role="note" className={sheetNote}>
          Mirror applies to the front camera only
        </p>
      )}
      <div
        data-camera-select-row
        className="pointer-events-auto flex w-full flex-col gap-1 px-1 py-1"
      >
        <label
          htmlFor="scan-camera-select"
          className="px-2 text-[10px] font-semibold uppercase tracking-wide text-ink-400 dark:text-ink-300"
        >
          Camera
        </label>
        <select
          id="scan-camera-select"
          data-camera-select
          aria-label="Choose camera"
          value={selectedDeviceId ?? ''}
          onChange={(e) => {
            const id = e.target.value === '' ? null : e.target.value;
            pickCamera(id);
          }}
          className="camera-select-compact pointer-events-auto inline-flex max-h-[44px] min-h-[44px] w-full truncate rounded-lg border border-paper-300 bg-paper-50 px-2 py-1 text-xs text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:bg-ink-800 dark:text-paper-100 dark:hover:bg-ink-700"
        >
          <option value="">Default camera</option>
          {cameras.map((c, i) => (
            <option key={c.deviceId} value={c.deviceId}>
              {cameraDisplayName(c, i)}
            </option>
          ))}
        </select>
        {deviceFallbackNote !== null && (
          <p data-camera-fallback-note role="status" className={sheetNote}>
            {deviceFallbackNote}
          </p>
        )}
        {suggestedDeviceId !== null && (
          <div
            data-camera-suggest
            role="status"
            className="pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border border-paper-300 px-3 py-1 text-[11px] text-ink-700 dark:border-ink-700 dark:text-paper-100"
          >
            <span>Sharper camera found — switch</span>
            <button
              type="button"
              aria-label="Switch to sharper camera"
              onClick={() => chooseCamera(suggestedDeviceId)}
              className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-ink-900 px-3 text-[11px] font-semibold text-paper-50 dark:bg-paper-50 dark:text-ink-900"
            >
              Switch
            </button>
          </div>
        )}
        {torchNote !== null && torchSupported && (
          <p data-torch-note role="status" className={sheetNote}>
            {torchNote}
          </p>
        )}
      </div>
      <div className="px-1 py-1">
        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400 dark:text-ink-300">
          Capture mode
        </p>
        <div
          data-scan-mode
          role="group"
          aria-label="Capture mode"
          className="inline-flex w-full rounded-full border border-paper-300 p-1 dark:border-ink-700"
        >
          <button
            type="button"
            aria-pressed={mode === 'manual'}
            onClick={() => setMode('manual')}
            className={`inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
              mode === 'manual'
                ? 'bg-ink-900 text-paper-50 dark:bg-paper-50 dark:text-ink-900'
                : 'text-ink-500 dark:text-ink-300'
            }`}
          >
            Manual
          </button>
          <button
            type="button"
            aria-pressed={mode === 'auto'}
            onClick={() => setMode('auto')}
            className={`inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
              mode === 'auto'
                ? 'bg-ink-900 text-paper-50 dark:bg-paper-50 dark:text-ink-900'
                : 'text-ink-500 dark:text-ink-300'
            }`}
          >
            Auto capture
          </button>
        </div>
      </div>
      {isCaptureSpansEnabled() && (
        <div className="px-1 py-1">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400 dark:text-ink-300">
            Capture quality
          </p>
          <div
            data-capture-quality
            role="group"
            aria-label="Capture quality"
            className="inline-flex w-full rounded-full border border-paper-300 p-1 dark:border-ink-700"
          >
            <button
              type="button"
              aria-pressed={!bareCapture}
              onClick={() => {
                try {
                  globalThis.localStorage?.removeItem(BARE_CAPTURE_STORAGE_KEY);
                } catch {
                  // Private mode / blocked storage — state still updates.
                }
                setBareCapture(false);
              }}
              className={`inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
                !bareCapture
                  ? 'bg-ink-900 text-paper-50 dark:bg-paper-50 dark:text-ink-900'
                  : 'text-ink-500 dark:text-ink-300'
              }`}
            >
              Max detail
            </button>
            <button
              type="button"
              aria-pressed={bareCapture}
              onClick={() => {
                try {
                  globalThis.localStorage?.setItem(BARE_CAPTURE_STORAGE_KEY, '1');
                } catch {
                  // Private mode / blocked storage — state still updates.
                }
                setBareCapture(true);
              }}
              className={`inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
                bareCapture
                  ? 'bg-ink-900 text-paper-50 dark:bg-paper-50 dark:text-ink-900'
                  : 'text-ink-500 dark:text-ink-300'
              }`}
            >
              Fast capture (test)
            </button>
          </div>
          <p data-capture-quality-note role="note" className={sheetNote}>
            Native-default resolution — for measurement only
          </p>
        </div>
      )}
      <SheetRowButton
        icon="▦"
        label="Add image files instead"
        onClick={() => fileInputRef.current?.click()}
      />
      <p className={sheetNote}>On-device ML auto-crop — images never leave this device.</p>
    </div>
  );

  const content = (
    <div
      data-scanner-root
      data-detector={DEFAULT_DETECTOR}
      className="fixed inset-0 z-50 flex max-h-[100dvh] flex-col overflow-hidden bg-paper-50 text-ink-900 [--finder-clear:5.5rem] sm:[--finder-clear:6rem] dark:bg-ink-900 dark:text-paper-100"
    >
      <FinderChrome
        onExit={onExit}
        sheetOpen={sheetOpen}
        onToggleSheet={() => setSheetOpen((v) => !v)}
        sheet={isCamera ? cameraSheet : null}
      />

      {isCamera && (
        // Full-bleed camera: the viewfinder is an absolute inset-0 layer of
        // the fixed surface with video object-cover filling it EXACTLY — no
        // aspect/max-w box, so black bars are impossible by construction.
        // All chrome (top bar, filmstrip, controls) floats over the video,
        // so captures can never shift layout by construction. dvh-safe: the
        // fixed root already tracks the dynamic viewport; bottom chrome pads
        // for the OS safe-area inset.
        <>
          <div className="absolute inset-0 z-0 overflow-hidden bg-ink-950">
            {camState === 'live' || camState === 'requesting' ? (
              <div data-viewfinder className="absolute inset-0 overflow-hidden bg-black">
                <video
                  ref={setVideoEl}
                  muted
                  playsInline
                  autoPlay
                  aria-label="Camera preview"
                  style={previewMirrored ? { transform: 'scaleX(-1)' } : undefined}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                {/* Finder guidance frame: rounded-rect overlay with corner
                    ticks. Top clearance comes from `--finder-clear` (set on
                    the scanner root, responsive via the `sm:` override) so
                    the slim top bar + compact camera-select row never
                    overlap the ticks — no hardcoded padding beside
                    stacking notes. The bottom scrim stays translucent so
                    the corner ticks read through. */}
                <div
                  data-finder-frame
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 pt-[var(--finder-clear)] sm:p-10 sm:pt-[var(--finder-clear)]"
                >
                  <div className="relative h-full w-full rounded-2xl">
                    <span className="absolute left-0 top-0 h-9 w-9 rounded-tl-2xl border-l-4 border-t-4 border-paper-50/90" />
                    <span className="absolute right-0 top-0 h-9 w-9 rounded-tr-2xl border-r-4 border-t-4 border-paper-50/90" />
                    <span className="absolute bottom-0 left-0 h-9 w-9 rounded-bl-2xl border-b-4 border-l-4 border-paper-50/90" />
                    <span className="absolute bottom-0 right-0 h-9 w-9 rounded-br-2xl border-b-4 border-r-4 border-paper-50/90" />
                  </div>
                </div>
                {/* Status pill rides top-center below the slim top bar
                    (`--finder-clear` clears it, same var as the frame) so the
                    bottom overlay can never cover it. Rendered ONLY when
                    actionable — a quiet Manual idle shows NO pill. */}
                {finderPill !== null && (
                  <p
                    data-finder-status
                    role="status"
                    className="absolute left-1/2 top-[var(--finder-clear)] max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-ink-950/70 px-4 py-2 text-center text-sm font-medium text-paper-50 backdrop-blur"
                  >
                    {finderPill}
                  </p>
                )}
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-ink-950 p-4 pb-52 pt-20">
                {/* No-preview fallback fills the same full-bleed slot (lifted
                    above the slim bottom overlay) so the controls never move
                    between camera states. */}
                <div className="rounded-xl border border-dashed border-paper-300 bg-paper-50 px-4 py-6 text-center dark:border-ink-700 dark:bg-ink-900">
                  <p
                    data-finder-status
                    role="status"
                    className="text-sm text-ink-500 dark:text-ink-300"
                  >
                    {cameraHelp}
                  </p>
                  {/* Recovery is never a dead end: retry when denial may be
                      transient, and always the Import alternate (same hidden
                      file input as the bottom overlay) — files stay on-device. */}
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    {camState === 'denied' && (
                      <button
                        type="button"
                        onClick={() => setRetryNonce((n) => n + 1)}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
                      >
                        Retry camera
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
                    >
                      Add image files instead
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bottom overlay: slim count bar + shutter cluster over a bottom
              scrim (pointer-events-none except the controls). The strip slot
              stays reserved at a fixed height (F-15 zero-shift): empty shows
              nothing visible, N>0 shows the slim review CTA bar. Secondary
              controls (mode, import) live in the More sheet — the bottom
              holds ONE primary action (72px shutter, thumb zone) plus the
              bottom-right count entry into review. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink-950/70 via-ink-950/30 to-transparent"
            />
            <div className="pointer-events-auto relative flex flex-col gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10">
              <div data-scan-strip className="flex h-12 shrink-0 items-center justify-center">
                {queue.length === 0 ? (
                  <span aria-hidden="true" className="block h-full w-full" />
                ) : (
                  <button
                    type="button"
                    data-review-cta
                    onClick={() => goToReview()}
                    className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-paper-50/95 px-5 py-2 text-sm font-medium text-ink-900 backdrop-blur transition-colors hover:bg-paper-200"
                  >
                    {`View ${queue.length} pages`}
                  </button>
                )}
              </div>

              {/* Bottom cluster: balance spacer · shutter · count entry */}
              <div className="flex items-center justify-between gap-4 px-2">
                <span aria-hidden className="w-14 shrink-0" />
                {camState === 'live' ? (
                  <button
                    type="button"
                    data-scan-capture
                    aria-label="Capture page"
                    autoFocus
                    disabled={capturing}
                    onClick={manualCapture}
                    className="inline-flex h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-brass-400/70 bg-ink-900 text-paper-50 shadow-soft transition-transform active:scale-95 disabled:opacity-60 dark:bg-paper-50 dark:text-ink-900"
                  >
                    <span aria-hidden className="h-12 w-12 rounded-full bg-brass-400" />
                  </button>
                ) : (
                  <span aria-hidden className="h-[72px] w-[72px] shrink-0" />
                )}
                <button
                  type="button"
                  data-scan-gallery
                  aria-label={
                    queue.length > 0 ? `Open review, ${queue.length} pages` : 'Open review'
                  }
                  disabled={queue.length === 0}
                  onClick={() => goToReview(queue.length - 1)}
                  className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-paper-50/25 bg-ink-950/60 text-paper-100 backdrop-blur transition-colors disabled:opacity-40"
                >
                  {gallerySrc ? (
                    <img
                      src={gallerySrc}
                      alt=""
                      decoding="async"
                      className="h-full w-full rounded-xl object-cover"
                    />
                  ) : (
                    <span aria-hidden className="text-lg">
                      ▦
                    </span>
                  )}
                  {pendingShotUrl !== null && capturing && (
                    <span
                      aria-hidden
                      className="absolute inset-0 flex items-center justify-center rounded-xl bg-ink-950/40 text-sm text-paper-100"
                    >
                      …
                    </span>
                  )}
                  {queue.length > 0 && (
                    <span
                      data-gallery-count
                      aria-hidden
                      className="absolute -right-1.5 -top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-brass-400 px-1 text-[11px] font-bold tabular-nums text-ink-950"
                    >
                      {queue.length}
                    </span>
                  )}
                </button>
              </div>
              {captureError !== null && (
                <p role="alert" className="text-center text-xs text-red-300">
                  {captureError}
                </p>
              )}

              {/* Hidden file input: the sheet's Import row + the fallback
                  card share it (files stay on-device). Always mounted. */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                multiple
                className="hidden"
                aria-label="Add image files instead"
                onChange={(e) => {
                  addFilesInstead(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        </>
      )}

      {phase === 'review' && current !== null && (
        <div
          data-scan-queue
          className="relative min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(4rem,calc(env(safe-area-inset-top)_+_3rem))]"
        >
          {preparing && (
            <div
              data-review-preparing
              role="status"
              className="sticky top-0 z-10 flex items-center justify-center gap-3 rounded-xl border border-brass-400/40 bg-paper-100 px-4 py-2.5 text-center dark:border-brass-400/30 dark:bg-ink-800"
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-brass-400 motion-reduce:animate-none"
              />
              <p className="min-w-0 flex-1 text-sm font-medium text-ink-700 dark:text-paper-100">
                {`Preparing pages… ${preparingDone} of ${preparingTotal}`}
              </p>
              <button
                type="button"
                data-review-preparing-cancel
                onClick={cancelPreparing}
                className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
              >
                Cancel
              </button>
            </div>
          )}
          {cardError !== null && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {cardError}
            </p>
          )}
          {/* Pager: minimal prev/next + dots. Labels stay pinned (‹/› glyphs
              with EXACT sr-only labels, same pattern as the review card's
              icon row); dots are additive 44px navigation. No accept click
              anywhere. */}
          <div className="flex items-center justify-center gap-1">
            <button
              type="button"
              data-page-prev
              aria-label="Go to previous page"
              disabled={safeIndex <= 0}
              onClick={() => setReviewIndex((i) => Math.max(0, i - 1))}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl px-2 text-lg font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              <span aria-hidden>‹</span>
              <span className="sr-only">Previous page</span>
            </button>
            <div
              role="group"
              aria-label="Pages"
              className="flex min-w-0 flex-1 items-center justify-center gap-0 overflow-x-auto"
            >
              {queue.map((entry, i) => (
                <button
                  key={entry.id}
                  type="button"
                  data-page-dot={i}
                  aria-label={`Go to page ${i + 1}`}
                  aria-current={i === safeIndex}
                  onClick={() => setReviewIndex(i)}
                  className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center"
                >
                  <span
                    aria-hidden
                    className={`rounded-full transition-colors ${
                      i === safeIndex
                        ? 'h-2.5 w-2.5 bg-brass-400'
                        : 'h-1.5 w-1.5 bg-ink-300 dark:bg-ink-600'
                    }`}
                  />
                </button>
              ))}
            </div>
            <button
              type="button"
              data-page-next
              aria-label="Go to next page"
              disabled={safeIndex >= queue.length - 1}
              onClick={() => setReviewIndex((i) => Math.min(queue.length - 1, i + 1))}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl px-2 text-lg font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              <span aria-hidden>›</span>
              <span className="sr-only">Next page</span>
            </button>
          </div>
          <ScanicReview
            key={current.id}
            photoUrl={current.photoUrl}
            imageWidth={current.imageWidth}
            imageHeight={current.imageHeight}
            corners={current.corners}
            warpedUrl={current.warpedUrl}
            detecting={current.status !== 'ready'}
            note={current.note}
            pageLabel={`Page ${safeIndex + 1} of ${queue.length}`}
            progressLabel={`${visitedCount} of ${queue.length} viewed`}
            onAdjustApply={(corners) => void rewrapEntry(current.id, corners)}
            onUseOriginal={() => toggleVerdict(current.id)}
            onDiscard={() => discardEntry(current.id)}
            onRedetect={() => void redetectEntry(current)}
            // Disabled until this page settles `ready`: the review drain owns
            // detecting pages, and Re-detect shares its lane-0 client — an
            // early tap would only duplicate the drain's detect.
            redetecting={redetecting || current.status !== 'ready'}
            verdict={current.decision}
            // Pure navigation beside Apply: advance reviewIndex only — no
            // warp, no decision change, no verdict touch. Visited marking
            // flows through the reviewIndex change like filmstrip/pager taps.
            onNextPage={() => setReviewIndex((i) => Math.min(queue.length - 1, i + 1))}
          />
          {/* Review filmstrip (owned here — ScanicReview renders the single
              card only): numbered thumbs jump to a page, + returns to camera.
              Slim (h-12) with 44px targets kept. */}
          <div
            data-scan-filmstrip
            aria-label="Scanned pages"
            className="flex items-center gap-2 overflow-x-auto py-1"
          >
            {queue.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                data-film-thumb
                aria-label={`Go to page ${i + 1} (${entry.decision === 'warped' ? 'auto-crop kept' : 'original kept'})`}
                aria-current={i === safeIndex}
                onClick={() => setReviewIndex(i)}
                className={`relative h-12 w-11 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                  i === safeIndex ? 'border-brass-400' : 'border-paper-200 dark:border-ink-700'
                }`}
              >
                {entry.photoUrl ? (
                  <img
                    src={entry.photoUrl}
                    alt=""
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-paper-200 text-[10px] text-ink-400 dark:bg-ink-700 dark:text-ink-300">
                    {i + 1}
                  </span>
                )}
                {entry.status !== 'ready' && (
                  <span className="absolute inset-0 flex items-center justify-center bg-ink-950/50 text-[9px] font-medium text-paper-50">
                    …
                  </span>
                )}
                <span className="absolute left-1 top-1 rounded-full bg-ink-950/70 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-paper-50">
                  {i + 1}
                </span>
              </button>
            ))}
            <button
              type="button"
              data-scan-add
              aria-label="Back to camera"
              onClick={() => setPhase('camera')}
              className="inline-flex h-12 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-dashed border-paper-300 px-3 text-sm font-medium text-ink-500 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700"
            >
              + Add
            </button>
          </div>
          {/* Batch bar: discard-all (confirm-free, everything) vs Next.
              Next needs >=1 page (implicit accept — no per-page gate). */}
          <div
            data-batch-bar
            className="flex items-center justify-between gap-2 border-t border-paper-200/70 pt-3 dark:border-ink-700/70"
          >
            <button
              type="button"
              onClick={discardAll}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl px-5 py-2.5 text-sm font-medium text-ink-500 transition-colors hover:bg-paper-200 dark:text-ink-300 dark:hover:bg-ink-700"
            >
              Discard scans
            </button>
            <button
              type="button"
              disabled={queue.length === 0}
              onClick={() => setPhase('done')}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(4rem,calc(env(safe-area-inset-top)_+_3rem))] text-center">
          <p className="font-display text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100">
            {accepted.length > 0 ? 'All pages ready' : 'No pages kept'}
          </p>
          <p
            data-review-progress
            aria-label={`${visitedCount} of ${accepted.length} viewed`}
            className="text-xs text-ink-400 dark:text-ink-300"
          >
            {visitedCount} of {accepted.length} viewed
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              disabled={accepted.length === 0}
              onClick={() => void buildPdf()}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
            >
              Build PDF
            </button>
            <button
              type="button"
              onClick={() => setPhase('camera')}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Back to camera
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // Single body portal carries the full-screen root (mounted on
  // document.body, never in AnimatePresence). Corner adjust lives inside
  // the review component, not in a separate overlay.
  if (typeof document !== 'undefined' && document.body) {
    return createPortal(content, document.body);
  }
  return content;
}
