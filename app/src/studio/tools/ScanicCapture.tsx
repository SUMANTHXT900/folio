/**
 * ScanicCapture — camera session + result-FIRST review queue for document scanning.
 *
 * Full-screen takeover: the scanner root is portaled to `document.body` as a
 * `fixed inset-0 z-50` surface (Folio paper/ink theme) with body scroll-lock
 * while mounted. The camera phase leads with a full-bleed viewfinder — no
 * scroll needed to find it. The portal is NEVER wrapped in AnimatePresence.
 *
 * Detection is ML-first (self-hosted same-origin assets under
 * `public/assets/scanic-ml/`), classical only as an honest fallback when the
 * ML detector throws. Corner *types* come from the worker agent's barrel
 * (`./scan/index`), the single source of truth; the queue runtime here is
 * intentionally inline (main-thread `scanDocument`/`extractDocument` per
 * capture) so the review UI works standalone — swapping the internals onto
 * `useScanicProcessor` later must keep the DOM contract below byte-for-byte.
 *
 * Preview vs detection: the <video> preview pixels are NEVER the detection
 * input — detection runs on the captured still through scanic's own internal
 * downscale (`scanDocument` scales to detection size itself). Preview
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
 * ratio anywhere); the live stream aspect from `track.getSettings()` is
 * reflected onto the video box so a 1440p landscape webcam never renders
 * as a blurry zoomed crop.
 *
 * E2E DATA CONTRACT (do not rename):
 * - root `[data-scanner-root]` (+ `data-detector="ml"`), shutter
 *   `[data-scan-capture]` (rendered only when live), gallery thumb
 *   `[data-scan-gallery]` (last queued thumb, jumps to review), mode pill
 *   `[data-scan-mode]` (`Manual` default / `Auto capture`), queue
 *   `[data-scan-queue]` with header `Page i of N`, result
 *   `[data-crop-result]` + `[data-crop-result-img]`, handles
 *   `[data-crop-handle="tl|tr|br|bl"]` (role=slider, arrow-key
 *   steppable via scanic's keyboard mode), review CTA `[data-review-cta]`
 *   (`View N pages` — every queued page is implicitly accepted, no pending),
 *   progress `[data-review-progress]` (aria-label `i of N viewed`, visited
 *   count — INTENTIONAL contract change from `reviewed`), pager
 *   `[data-page-prev]` / `[data-page-next]` (44px, disabled at ends),
 *   finder `[data-finder-frame]` + `[data-finder-status]`, mirror
 *   `[data-mirror-toggle]` (aria-pressed), filmstrip `[data-scan-filmstrip]`
 *   + `[data-film-thumb]` (numbered, tap jumps) + `[data-scan-add]` (back
 *   to camera), batch bar `[data-batch-bar]` (`Discard scans` ghost /
 *   `Next` primary, gated on >=1 page).
 * - Queue button labels are EXACT: "Adjust corners", "Apply",
 *   "Use original" (toggle warped <-> original), "Discard", "Reset to auto",
 *   "Build PDF", "Back to camera", "Re-detect", "Previous page",
 *   "Next page", "Next", "Discard scans". No "Looks good" exists anywhere —
 *   seeing a fine page is enough to move on (implicit accept).
 *
 * Binary ownership: originals live as File handles in refs/state (never
 * re-encoded, never base64); only object-URL strings enter React state, and
 * every URL is revoked on discard/commit/unmount. Warped commits are full-res
 * JPEG q0.9 renders from `extractDocument(..., { output: 'canvas' })` via
 * `canvasToJpeg(0.9)` — warped pages are NEW renders (never original bytes;
 * originals still pass through byte-identical), and JPEG q0.9 full-res cuts
 * multi-MB PNG bloat to a fraction with no readable-text loss (4-page 22MB
 * class problem). Committed warped files keep `scan-NNN.jpg` names with
 * `image/jpeg` type.
 *
 * Corner adjust lives in `./ScanicReview` (dependency-free handles on the
 * overlay coordinate space, same E2E labels + 44px targets); this file owns
 * queue/camera/commit only and re-warps on every Apply so previews stay
 * reactive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { extractDocument, scanDocument } from 'scanic';
import type { ScanicCorners } from './scan/index';
import {
  DEFAULT_DETECTOR,
  ML_ASSET_BASE_URL as POLICY_ML_ASSET_BASE_URL,
  warmMlDetector,
} from './scan/detectorPolicy';
import ScanicReview from './ScanicReview';

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

function readStoredCameraId(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(CAMERA_STORAGE_KEY);
    if (typeof raw === 'string' && raw !== '') return raw;
    return null;
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
 * Minimum time the "Scanning… hold steady" pill stays visible after the last
 * detection settles. Detection often resolves in ~200ms — faster than anyone
 * can read — so without a dwell the working state flashes past unreadably.
 */
export const SCAN_STATUS_DWELL_MS = 800;

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

/** Downscaled grayscale snapshot of the live preview; null when unreadable. */
function samplePreviewGrayscale(video: HTMLVideoElement): Uint8Array | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = AUTO_CAPTURE_SAMPLE_W;
    canvas.height = AUTO_CAPTURE_SAMPLE_H;
    const ctx = canvas.getContext('2d');
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
  /** Detection baseline in image-space pixels; null while detecting/failed. */
  corners: ScanicCorners | null;
  warpedUrl: string | null;
  status: 'detecting' | 'ready';
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
 * Warped-page encoder: full-res `image/jpeg` at quality 0.9.
 *
 * Rationale: warped pages are NEW renders (never original bytes — originals
 * still pass through byte-identical), and JPEG q0.9 full-res cuts multi-MB
 * PNG bloat to a fraction with no readable-text loss (4-page 22MB class
 * problem). Committed warped files keep `scan-NNN.jpg` names with
 * `image/jpeg` type. Full-res means the extract canvas pixels as-is (no
 * downscale); only the container changes (PNG → JPEG).
 */
function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.9): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
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
  /** Live stream aspect (`W / H`) read from `track.getSettings()` — honest preview, never forced. */
  const [liveAspect, setLiveAspect] = useState<string | null>(null);
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
  const streamRef = useRef<MediaStream | null>(null);
  /** Session ref mirror of the camera choice (survives effect remounts within the session). */
  const chosenDeviceIdRef = useRef<string | null>(initialCameraChoice());
  /** Best-camera probe guards: fire once per mount, generation-checked (StrictMode-safe). */
  const probeFiredRef = useRef(false);
  const probeGenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const imageElsRef = useRef(new Map<number, HTMLImageElement>());
  const warpedBlobsRef = useRef(new Map<number, Blob>());
  const objectUrlsRef = useRef(new Set<string>());
  /** Last shutter time (manual or auto) — the auto cooldown gates on this. */
  const lastFireRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    };
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

  // Warm preload at scanner open: the ORT runtime + model bytes load while
  // the user frames the first page, so the first capture never pays the
  // load. Fire-and-forget; failure falls back silently per-entry.
  useEffect(() => {
    void warmMlDetector();
  }, []);

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

  /* ---------------- detection (ML default, classical fallback) ---------------- */

  const detectEntry = useCallback(async (id: number, photoUrl: string) => {
    const { el, w, h } = await loadImage(photoUrl);
    if (!mountedRef.current) return;
    if (w === 0 || h === 0) {
      imageElsRef.current.set(id, el);
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
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
    imageElsRef.current.set(id, el);
    setEntries((prev) =>
      prev.map((e) =>
        e.id === id
          ? { ...e, imageWidth: w, imageHeight: h, note: 'Loading on-device ML detector…' }
          : e,
      ),
    );
    try {
      // ML-first: DocCornerNet via vendored same-origin assets. Preview pixels
      // are never the detection input — scanic downscales internally, so the
      // high-res viewfinder only affects what the user sees.
      // Null-means-missed (not just throws): when ML succeeds but finds no
      // quad, classical gets one attempt — it sees different features and
      // regularly catches what ML passes over (and vice versa). Only when
      // BOTH find nothing does the page settle croppable full-frame.
      const result = await scanDocument(el, {
        detector: DEFAULT_DETECTOR,
        ml: { assetBaseUrl: SCANIC_ML_ASSET_BASE_URL },
      });
      if (!mountedRef.current) return;
      if (result.corners !== null) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? { ...e, status: 'ready' as const, corners: result.corners, note: null }
              : e,
          ),
        );
        return;
      }
      const second = await scanDocument(el, { detector: 'classical' });
      if (!mountedRef.current) return;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                status: 'ready' as const,
                corners: second.corners,
                note:
                  second.corners === null
                    ? 'Auto-detect found no page — the full frame will be used. Adjust corners to crop manually.'
                    : 'ML found no page — classical detection placed this outline; adjust freely.',
              }
            : e,
        ),
      );
    } catch {
      // ML can fail (model fetch, ORT runtime); fall back to classical once,
      // honestly labelled. Classical failure degrades to full-frame.
      if (!mountedRef.current) return;
      try {
        const fallback = await scanDocument(el, { detector: 'classical' });
        if (!mountedRef.current) return;
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: 'ready' as const,
                  corners: fallback.corners,
                  note: 'ML detector unavailable — used on-device classical detection instead.',
                }
              : e,
          ),
        );
        return;
      } catch {
        if (!mountedRef.current) return;
      }
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
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
  }, []);

  /**
   * Enqueues an untouched original File for detection. Returns the queue
   * position (worker-hook seam: same name, same shape as `./scan/index`).
   */
  const enqueueCapture = useCallback(
    (file: File): number => {
      const id = idRef.current + 1;
      idRef.current = id;
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
          status: 'detecting' as const,
          decision: 'warped' as const,
          note: null,
        },
      ];
      entriesRef.current = next;
      setEntries(next);
      void detectEntry(id, photoUrl);
      return position;
    },
    [detectEntry, trackUrl],
  );

  const redetectEntry = useCallback(
    async (entry: QueueEntry) => {
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
        await detectEntry(entry.id, entry.photoUrl);
      } finally {
        if (mountedRef.current) setRedetecting(false);
      }
    },
    [detectEntry],
  );

  /* ---------------- camera session ---------------- */

  const stopTracks = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

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
    setLiveAspect(null);
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
        // Honest preview aspect: read the LIVE stream settings (actual
        // sensor mode), never a hardcoded ratio — the full-bleed
        // `object-cover` layer crops, never stretches, so a landscape
        // webcam renders landscape instead of a blurry zoomed portrait crop.
        try {
          const settings = track?.getSettings?.() as
            { width?: number; height?: number; facingMode?: string } | undefined;
          if (
            !cancelled &&
            typeof settings?.width === 'number' &&
            typeof settings?.height === 'number' &&
            settings.width > 0 &&
            settings.height > 0
          ) {
            setLiveAspect(`${settings.width} / ${settings.height}`);
          }
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
   * persisted pick wins overall). StrictMode-safe: `probeFiredRef` fires once
   * per mount and the generation guard drops the late double-mount result.
   */
  useEffect(() => {
    if (phase !== 'camera' || paused) return;
    if (camState !== 'live') return;
    if (cameras.length < 2) return;
    const activePick = chosenDeviceIdRef.current ?? selectedDeviceId;
    if (activePick !== null && activePick !== '') return;
    if (probeFiredRef.current) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    probeFiredRef.current = true;
    const gen = (probeGenRef.current += 1);
    let alive = true;
    (async () => {
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
    return () => {
      alive = false;
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
   */
  const captureFrame = useCallback(async () => {
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0] ?? null;
    setCaptureError(null);
    if (!track || track.readyState === 'ended') {
      setCaptureError('Camera is not ready yet — wait for the preview, then try again.');
      return;
    }
    const ImageCaptureCtor = getImageCaptureCtor();
    if (ImageCaptureCtor) {
      try {
        const capture = new ImageCaptureCtor(track);
        let photoSettings: { imageWidth?: number; imageHeight?: number } | undefined;
        try {
          if (typeof capture.getPhotoCapabilities === 'function') {
            const caps = await capture.getPhotoCapabilities();
            const maxW = caps.imageWidth?.max;
            const maxH = caps.imageHeight?.max;
            if (typeof maxW === 'number' && typeof maxH === 'number') {
              photoSettings = { imageWidth: maxW, imageHeight: maxH };
            }
          }
        } catch {
          // Capabilities unreadable — fall through to the native default.
          photoSettings = undefined;
        }
        const blob =
          photoSettings !== undefined
            ? await capture.takePhoto(photoSettings)
            : await capture.takePhoto();
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
      setCaptureError('Could not read a camera frame on this browser — add an image file instead.');
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
  }, [enqueueCapture]);

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

  const goToReview = useCallback((index?: number) => {
    setReviewIndex(index ?? 0);
    setPhase('review');
  }, []);

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
   */
  const rewrapEntry = useCallback(
    async (id: number, corners: ScanicCorners) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      const img = imageElsRef.current.get(id);
      if (!entry || !img) return;
      setCardError(null);
      try {
        const result = await extractDocument(img, corners, { output: 'canvas' });
        const canvas = result.output as HTMLCanvasElement | null;
        if (!canvas) throw new Error('no canvas');
        const blob = await canvasToJpeg(canvas, 0.9);
        if (!blob) throw new Error('no jpeg');
        if (!mountedRef.current) return;
        warpedBlobsRef.current.set(id, blob);
        revokeUrl(entriesRef.current.find((e) => e.id === id)?.warpedUrl ?? null);
        const url = trackUrl(URL.createObjectURL(blob));
        lastWarpedQuadRef.current.set(id, JSON.stringify(corners));
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, corners, warpedUrl: url } : e)),
        );
      } catch {
        if (mountedRef.current)
          setCardError('Warp failed on this page — nothing changed. Use the original instead.');
      }
    },
    [revokeUrl, trackUrl],
  );

  const discardEntry = useCallback(
    (id: number) => {
      const target = entriesRef.current.find((e) => e.id === id);
      if (target) {
        revokeUrl(target.photoUrl);
        revokeUrl(target.warpedUrl);
        warpedBlobsRef.current.delete(id);
        imageElsRef.current.delete(id);
        lastWarpedQuadRef.current.delete(id);
        eagerAttemptRef.current.delete(id);
        visitedIdsRef.current.delete(id);
      }
      const next = entriesRef.current.filter((e) => e.id !== id);
      entriesRef.current = next;
      setEntries(next);
      setTimeout(() => {
        if (!mountedRef.current) return;
        if (next.length === 0) setPhase('camera');
        else setReviewIndex((i) => Math.min(i, next.length - 1));
      }, 0);
    },
    [revokeUrl],
  );

  /**
   * Discard-all from the review batch bar: drops EVERYTHING back to the
   * camera, confirm-free. Revokes every queued URL so no blob leaks.
   */
  const discardAll = useCallback(() => {
    for (const entry of entriesRef.current) {
      revokeUrl(entry.photoUrl);
      revokeUrl(entry.warpedUrl);
      warpedBlobsRef.current.delete(entry.id);
      imageElsRef.current.delete(entry.id);
    }
    lastWarpedQuadRef.current.clear();
    eagerAttemptRef.current.clear();
    visitedIdsRef.current.clear();
    entriesRef.current = [];
    setEntries([]);
    setReviewIndex(0);
    setPhase('camera');
  }, [revokeUrl]);

  /**
   * EAGER warp: the review single canvas needs a `warpedUrl` the moment a
   * page has corners. When the review shows a ready page with corners whose
   * quad has no warp yet, re-warp immediately via the verdict-free
   * `rewrapEntry` core — no verdict change, ML-first / null-fallback /
   * commit paths untouched. Loop guard: one attempt per (entry, quad); skip
   * when the current `warpedUrl` was already built for these exact corners.
   * Runs for both verdicts so toggling back to warped is instant.
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
  }, [phase, current, eagerCornersKey, rewrapEntry]);

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

  const buildPdf = useCallback(() => {
    const pages: ScanicCommittedPage[] = accepted.map((entry, i) => {
      const name = formatScanName(startIndex + i);
      if (entry.decision !== 'original') {
        const blob = warpedBlobsRef.current.get(entry.id);
        if (blob) return { file: new File([blob], name, { type: 'image/jpeg' }), name };
      }
      // Verdict `original`, or warped verdict with no warp yet: the queued
      // File, byte-identical — renamed, never re-encoded.
      return {
        file: new File([entry.original], name, {
          type: entry.original.type || 'image/jpeg',
        }),
        name,
      };
    });
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

  const anyDetecting = queue.some((e) => e.status === 'detecting');
  const lastQueued = queue.length === 0 ? null : queue[queue.length - 1];

  // Minimum dwell for the working status: detection often settles in ~200ms
  // (warm ML session), faster than anyone can read — without a dwell the
  // "Scanning… hold steady" pill flashes past unreadably, and fast eyes (or
  // E2E) only ever see the idle text. The dwell keeps the working state
  // visible briefly AFTER the last settle; it never delays any action.
  const scanDwellUntilRef = useRef(0);
  const [, setDwellTick] = useState(0);
  useEffect(() => {
    // Empty queue (fresh open, discard-all): idle, never dwelling.
    if (queue.length === 0) {
      scanDwellUntilRef.current = 0;
      return;
    }
    if (queue.some((e) => e.status === 'detecting')) return;
    scanDwellUntilRef.current = Date.now() + SCAN_STATUS_DWELL_MS;
    // Repaint NOW: refs don't render by themselves, and with nothing else
    // scheduled the pill would freeze on the settle-time text (idle) for the
    // whole window. The trailing timeout repaints again at expiry.
    setDwellTick((t) => t + 1);
    const id = window.setTimeout(() => {
      if (mountedRef.current) setDwellTick((t) => t + 1);
    }, SCAN_STATUS_DWELL_MS + 50);
    return () => window.clearTimeout(id);
  }, [queue]);

  const finderStatus =
    camState === 'requesting'
      ? 'Starting camera…'
      : paused
        ? 'Paused (tab hidden) — preview resumes when you return.'
        : anyDetecting || Date.now() < scanDwellUntilRef.current
          ? 'Scanning… hold steady'
          : 'Point at the page';

  // Camera-phase flag: the camera is true full-bleed (video fills the
  // fixed surface edge-to-edge, chrome floats over it); review/done keep
  // the docked chrome. Single source for both strip variants below.
  const isCamera = phase === 'camera';
  // Session strip body — SAME thumbs/labels in both variants (floating
  // camera filmstrip + docked review/done strip); only the container
  // positioning differs by phase. Compact thumbs (h-14 w-11) keep 44px
  // targets in both.
  const stripBody =
    queue.length === 0 ? (
      <p
        className={
          isCamera ? 'text-xs text-paper-100/80' : 'text-xs text-ink-400 dark:text-ink-300'
        }
      >
        No pages yet — capture or add images.
      </p>
    ) : (
      queue.map((entry, i) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => goToReview(i)}
          aria-label={`Review page ${i + 1} (${entry.decision === 'warped' ? 'auto-crop kept' : 'original kept'})`}
          className={`relative h-14 w-11 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
            current?.id === entry.id && phase === 'review'
              ? 'border-brass-400'
              : 'border-paper-200 dark:border-ink-700'
          }`}
        >
          {entry.photoUrl ? (
            <img src={entry.photoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-paper-200 text-[10px] text-ink-400 dark:bg-ink-700">
              {i + 1}
            </span>
          )}
          {entry.status === 'detecting' && (
            <span className="absolute inset-0 flex items-center justify-center bg-ink-950/50 text-[9px] font-medium text-paper-50">
              …
            </span>
          )}
        </button>
      ))
    );

  // Review phase: the single-page card is owned by `./ScanicReview` (props
  // below stay EXACT minus the removed Looks-good reliance); the pager +
  // filmstrip + batch bar underneath are owned here because the review
  // component renders the card only (never duplicates).
  const content = (
    <div
      data-scanner-root
      data-detector={DEFAULT_DETECTOR}
      className="fixed inset-0 z-50 flex max-h-[100dvh] flex-col overflow-hidden bg-paper-50 text-ink-900 dark:bg-ink-900 dark:text-paper-100"
    >
      {/* Top chrome: camera phase is a slim two-row overlay (top bar +
          compact camera-select row) floating over the full-bleed video with
          a top scrim; review/done keep the docked solid bar. The finder
          frame below carries top clearance for both rows so no row ever
          overlaps the corner ticks. */}
      <div
        data-scanner-topbar
        className={
          isCamera
            ? 'pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-1 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]'
            : 'flex shrink-0 items-center gap-2 border-b border-paper-200/70 bg-paper-50/95 px-3 py-2 dark:border-ink-700/70 dark:bg-ink-900/95'
        }
      >
        {isCamera && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-ink-950/60 to-transparent"
          />
        )}
        {isCamera ? (
          <>
            <div className="relative flex w-full items-center gap-1">
              <button
                type="button"
                aria-label="Close scanner"
                onClick={onExit}
                className="pointer-events-auto relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-50/20 bg-ink-950/60 px-2 py-1 text-sm text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
              >
                ✕
              </button>
              <p className="relative min-w-0 flex-1 truncate text-center font-display text-sm font-semibold tracking-tight text-paper-50 drop-shadow">
                Scan documents
              </p>
              {torchSupported ? (
                <button
                  type="button"
                  aria-label="Toggle torch"
                  aria-pressed={torchOn}
                  onClick={() => void toggleTorch()}
                  className="pointer-events-auto relative inline-flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-xl border border-paper-50/20 bg-ink-950/60 px-2 py-1 text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
                >
                  <span aria-hidden className="text-sm leading-none">
                    {torchOn ? '🔦' : '💡'}
                  </span>
                  <span className="text-[10px] font-medium leading-none">Flash</span>
                </button>
              ) : (
                <span aria-hidden className="min-h-[44px] min-w-[44px]" />
              )}
              <button
                type="button"
                aria-label="Switch camera"
                onClick={() => {
                  // Quick flip alongside the picker: clears any explicit
                  // device pick (exact selection would otherwise ignore
                  // facingMode) so the flip always takes effect.
                  chooseCamera(null);
                  setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
                }}
                className="pointer-events-auto relative inline-flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-xl border border-paper-50/20 bg-ink-950/60 px-2 py-1 text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
              >
                <span aria-hidden className="text-sm leading-none">
                  ⇄
                </span>
                <span className="text-[10px] font-medium leading-none">Flip</span>
              </button>
              <button
                type="button"
                data-mirror-toggle
                aria-pressed={mirrored}
                aria-label="Mirror front-camera preview"
                title={
                  facing !== 'user'
                    ? 'Mirror applies to the front camera only'
                    : mirrored
                      ? 'Front preview mirrored (captures stay unmirrored)'
                      : 'Front preview unmirrored'
                }
                disabled={facing !== 'user'}
                onClick={() => setMirrored((v) => !v)}
                className="pointer-events-auto relative inline-flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-xl border border-paper-50/20 bg-ink-950/60 px-2 py-1 text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span aria-hidden className="text-sm leading-none">
                  {mirrored ? '◐' : '◑'}
                </span>
                <span className="text-[10px] font-medium leading-none">Mirror</span>
              </button>
            </div>
            {cameras.length > 0 && (
              <div
                data-camera-select-row
                className="pointer-events-auto relative flex w-full flex-col items-center justify-center gap-1"
              >
                <select
                  data-camera-select
                  aria-label="Choose camera"
                  value={selectedDeviceId ?? ''}
                  onChange={(e) => {
                    const id = e.target.value === '' ? null : e.target.value;
                    // Keep the mirror semantics honest when the OS label
                    // names a side: a picked front lens mirrors the
                    // preview, a picked back lens never does. Unknown
                    // labels leave the facing toggle untouched (the live
                    // track's facingMode reconciles after start when
                    // exposed).
                    const picked = cameras.find((c) => c.deviceId === id);
                    const lbl = (picked?.label ?? '').toLowerCase();
                    if (id !== null && /front|user|facetime|selfie/.test(lbl)) setFacing('user');
                    else if (id !== null && /back|rear|environment/.test(lbl))
                      setFacing('environment');
                    chooseCamera(id);
                  }}
                  className="camera-select-compact pointer-events-auto inline-flex max-w-56 truncate rounded-lg border border-paper-50/20 bg-ink-950/60 px-2 py-1 text-xs text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80 min-h-[44px]"
                >
                  <option value="">Default camera</option>
                  {cameras.map((c, i) => (
                    <option key={c.deviceId} value={c.deviceId}>
                      {cameraDisplayName(c, i)}
                    </option>
                  ))}
                </select>
                {deviceFallbackNote !== null && (
                  <p
                    data-camera-fallback-note
                    role="status"
                    className="max-w-full truncate rounded-full bg-ink-950/60 px-3 py-1 text-center text-[11px] text-paper-100 backdrop-blur"
                  >
                    {deviceFallbackNote}
                  </p>
                )}
                {suggestedDeviceId !== null && (
                  <div
                    data-camera-suggest
                    role="status"
                    className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-ink-950/60 px-3 py-1 text-[11px] text-paper-100 backdrop-blur"
                  >
                    <span>Sharper camera found — switch</span>
                    <button
                      type="button"
                      aria-label="Switch to sharper camera"
                      onClick={() => chooseCamera(suggestedDeviceId)}
                      className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-paper-50 px-3 text-[11px] font-semibold text-ink-900"
                    >
                      Switch
                    </button>
                  </div>
                )}
                {torchNote !== null && torchSupported && (
                  <p
                    data-torch-note
                    role="status"
                    className="max-w-full truncate rounded-full bg-ink-950/60 px-3 py-1 text-center text-[11px] text-paper-100 backdrop-blur"
                  >
                    {torchNote}
                  </p>
                )}
              </div>
            )}
            {cameras.length === 0 && torchNote !== null && torchSupported && (
              <p
                data-torch-note
                role="status"
                className="pointer-events-auto relative max-w-full truncate rounded-full bg-ink-950/60 px-3 py-1 text-center text-[11px] text-paper-100 backdrop-blur"
              >
                {torchNote}
              </p>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              aria-label="Close scanner"
              onClick={onExit}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-3 py-2 text-sm text-ink-500 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700"
            >
              ✕
            </button>
            <p className="min-w-0 flex-1 truncate text-center font-display text-sm font-semibold tracking-tight text-ink-900 dark:text-paper-100">
              Scan documents
            </p>
            {torchSupported ? (
              <button
                type="button"
                aria-label="Toggle torch"
                aria-pressed={torchOn}
                onClick={() => void toggleTorch()}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-3 py-2 text-sm text-ink-500 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700"
              >
                {torchOn ? '🔦' : '💡'}
              </button>
            ) : (
              <span aria-hidden className="min-h-[44px] min-w-[44px]" />
            )}
            {torchNote !== null && torchSupported && (
              <p data-torch-note role="status" className="text-xs text-ink-500 dark:text-ink-300">
                {torchNote}
              </p>
            )}
          </>
        )}
      </div>

      {/* Docked session strip for review/done — the camera phase uses the
          floating filmstrip inside the bottom overlay instead (same thumbs
          via stripBody above, always rendered so the slot never collapses). */}
      {!isCamera && (
        <div
          data-scan-strip
          className="flex h-20 shrink-0 items-center gap-2 overflow-x-auto border-b border-paper-200/70 bg-paper-50/95 px-4 py-2.5 dark:border-ink-700/70 dark:bg-ink-900/95"
        >
          {stripBody}
        </div>
      )}

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
                  ref={videoRef}
                  muted
                  playsInline
                  autoPlay
                  aria-label="Camera preview"
                  style={{
                    ...(previewMirrored ? { transform: 'scaleX(-1)' } : {}),
                    ...(liveAspect ? { aspectRatio: liveAspect } : {}),
                  }}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                {/* Finder guidance frame: rounded-rect overlay with corner
                    ticks. Top clearance (pt-36/sm:pt-40) clears the slim
                    top bar + compact camera-select row above, so no chrome
                    row ever overlaps the ticks; the bottom scrim stays
                    translucent so the corner ticks read through. */}
                <div
                  data-finder-frame
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 pt-36 sm:p-10 sm:pt-40"
                >
                  <div className="relative h-full w-full rounded-2xl">
                    <span className="absolute left-0 top-0 h-9 w-9 rounded-tl-2xl border-l-4 border-t-4 border-paper-50/90" />
                    <span className="absolute right-0 top-0 h-9 w-9 rounded-tr-2xl border-r-4 border-t-4 border-paper-50/90" />
                    <span className="absolute bottom-0 left-0 h-9 w-9 rounded-bl-2xl border-b-4 border-l-4 border-paper-50/90" />
                    <span className="absolute bottom-0 right-0 h-9 w-9 rounded-br-2xl border-b-4 border-r-4 border-paper-50/90" />
                  </div>
                </div>
                {/* Status pill rides top-center below the slim top bar +
                    compact select row (top-36 clears both) so the bottom
                    overlay can never cover it. Dwell text logic
                    (finderStatus) is unchanged. */}
                <p
                  data-finder-status
                  role="status"
                  className="absolute left-1/2 top-36 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-ink-950/70 px-4 py-2 text-center text-sm font-medium text-paper-50 backdrop-blur"
                >
                  {finderStatus}
                </p>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-ink-950 p-4 pb-72 pt-20">
                {/* No-preview fallback fills the same full-bleed slot (lifted
                    above the bottom overlay) so the controls never move
                    between camera states. */}
                <div className="rounded-xl border border-dashed border-paper-300 bg-paper-50 px-4 py-6 text-center dark:border-ink-700 dark:bg-ink-900">
                  <p
                    data-finder-status
                    role="status"
                    className="text-sm text-ink-500 dark:text-ink-300"
                  >
                    {cameraHelp}
                  </p>
                  {camState === 'denied' && (
                    <button
                      type="button"
                      onClick={() => setRetryNonce((n) => n + 1)}
                      className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
                    >
                      Retry camera
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Bottom overlay: floating filmstrip + controls over a bottom
              scrim (pointer-events-none except the controls). The strip keeps
              the same [data-scan-strip] thumbs, compact (h-16). The
              review-CTA slot stays reserved (min-h-[52px]) so the first
              capture never grows the overlay. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink-950/70 via-ink-950/30 to-transparent"
            />
            <div className="pointer-events-auto relative flex flex-col gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10">
              <div
                data-scan-strip
                className="flex h-16 shrink-0 items-center gap-2 overflow-x-auto py-1"
              >
                {stripBody}
              </div>
              {/* Manual/Auto segmented mode pill */}
              <div className="flex justify-center">
                <div
                  data-scan-mode
                  role="group"
                  aria-label="Capture mode"
                  className="inline-flex rounded-full border border-paper-50/25 bg-ink-950/60 p-1 backdrop-blur"
                >
                  <button
                    type="button"
                    aria-pressed={mode === 'manual'}
                    onClick={() => setMode('manual')}
                    className={`inline-flex min-h-[44px] items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
                      mode === 'manual' ? 'bg-paper-50 text-ink-900' : 'text-paper-100/75'
                    }`}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === 'auto'}
                    onClick={() => setMode('auto')}
                    className={`inline-flex min-h-[44px] items-center justify-center rounded-full px-5 text-sm font-medium transition-colors ${
                      mode === 'auto' ? 'bg-paper-50 text-ink-900' : 'text-paper-100/75'
                    }`}
                  >
                    Auto capture
                  </button>
                </div>
              </div>
              {mode === 'auto' && (
                <p className="text-center text-[11px] text-paper-100/75">
                  Hold steady over the page — the shutter fires itself.
                </p>
              )}

              {/* Bottom cluster: gallery thumb · big shutter · balance spacer */}
              <div className="flex items-center justify-between gap-4 px-2">
                <button
                  type="button"
                  data-scan-gallery
                  aria-label={
                    queue.length > 0 ? `Open review, ${queue.length} pages` : 'Open review'
                  }
                  disabled={queue.length === 0}
                  onClick={() => goToReview(queue.length - 1)}
                  className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-paper-50/25 bg-ink-950/60 text-paper-100 backdrop-blur transition-colors disabled:opacity-40"
                >
                  {lastQueued?.photoUrl ? (
                    <img src={lastQueued.photoUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span aria-hidden className="text-lg">
                      ▦
                    </span>
                  )}
                </button>
                {camState === 'live' ? (
                  <button
                    type="button"
                    data-scan-capture
                    aria-label="Capture page"
                    onClick={manualCapture}
                    className="inline-flex h-[76px] w-[76px] items-center justify-center rounded-full border-4 border-brass-400/70 bg-ink-900 text-paper-50 shadow-soft transition-transform active:scale-95 dark:bg-paper-50 dark:text-ink-900"
                  >
                    <span aria-hidden className="h-12 w-12 rounded-full bg-brass-400" />
                  </button>
                ) : (
                  <span aria-hidden className="h-[76px] w-[76px] shrink-0" />
                )}
                <span aria-hidden className="w-14 shrink-0" />
              </div>
              {captureError !== null && (
                <p role="alert" className="text-center text-xs text-red-300">
                  {captureError}
                </p>
              )}

              <div className="flex flex-col items-center gap-2">
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
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-50/25 bg-ink-950/60 px-5 py-2.5 text-sm font-medium text-paper-100 backdrop-blur transition-colors hover:bg-ink-950/80"
                >
                  Add image files instead
                </button>
                <p className="text-center text-[11px] text-paper-100/70">
                  On-device ML auto-crop — images never leave this device.
                </p>
                {/* Review-CTA slot: ALWAYS reserved at a fixed min-height so
                    the first capture never grows the overlay (and never moves
                    anything above it). The button itself stays queue-gated
                    per the E2E contract. */}
                <div className="flex min-h-[52px] items-center justify-center">
                  {queue.length > 0 && (
                    <button
                      type="button"
                      data-review-cta
                      onClick={() => goToReview()}
                      className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-paper-50 px-5 py-2.5 text-sm font-medium text-ink-900 transition-colors hover:bg-paper-200"
                    >
                      {`View ${queue.length} pages`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {phase === 'review' && current !== null && (
        <div data-scan-queue className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {cardError !== null && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {cardError}
            </p>
          )}
          {/* Pager beside the hero: prev/next page without any accept click. */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              data-page-prev
              aria-label="Go to previous page"
              disabled={safeIndex <= 0}
              onClick={() => setReviewIndex((i) => Math.max(0, i - 1))}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Previous page
            </button>
            <button
              type="button"
              data-page-next
              aria-label="Go to next page"
              disabled={safeIndex >= queue.length - 1}
              onClick={() => setReviewIndex((i) => Math.min(queue.length - 1, i + 1))}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Next page
            </button>
          </div>
          <ScanicReview
            key={current.id}
            photoUrl={current.photoUrl}
            imageWidth={current.imageWidth}
            imageHeight={current.imageHeight}
            corners={current.corners}
            warpedUrl={current.warpedUrl}
            detecting={current.status === 'detecting'}
            note={current.note}
            pageLabel={`Page ${safeIndex + 1} of ${queue.length}`}
            progressLabel={`${visitedCount} of ${queue.length} viewed`}
            onAdjustApply={(corners) => void rewrapEntry(current.id, corners)}
            onUseOriginal={() => toggleVerdict(current.id)}
            onDiscard={() => discardEntry(current.id)}
            onRedetect={() => void redetectEntry(current)}
            redetecting={redetecting}
            verdict={current.decision}
            // Pure navigation beside Apply: advance reviewIndex only — no
            // warp, no decision change, no verdict touch. Visited marking
            // flows through the reviewIndex change like filmstrip/pager taps.
            onNextPage={() => setReviewIndex((i) => Math.min(queue.length - 1, i + 1))}
          />
          {/* Review filmstrip (owned here — ScanicReview renders the single
              card only): numbered thumbs jump to a page, + returns to camera. */}
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
                className={`relative h-14 w-11 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                  i === safeIndex ? 'border-brass-400' : 'border-paper-200 dark:border-ink-700'
                }`}
              >
                {entry.photoUrl ? (
                  <img src={entry.photoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-paper-200 text-[10px] text-ink-400 dark:bg-ink-700">
                    {i + 1}
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
              className="inline-flex h-14 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-dashed border-paper-300 px-3 text-sm font-medium text-ink-500 transition-colors hover:bg-paper-200 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700"
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
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-center">
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
              onClick={buildPdf}
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
