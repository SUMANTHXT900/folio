/**
 * ScanicReview — processed-FIRST review card for one scanned page.
 *
 * Single-canvas contract: the result view (`[data-crop-result]`) shows ONLY
 * the ML auto-crop result (`warpedUrl`) as exactly one
 * `img[data-crop-result-img]` — never the bare photo beside it. While
 * `warpedUrl` is null the result view shows a `Processing auto-crop…`
 * skeleton (no photo canvas). "Use original" swaps that single canvas to the
 * photo behind an explicit "Original photo — unprocessed" chip (verdict
 * state, not a second canvas). There is no `[data-detect-overlay]` in the
 * result view and no enhance/filter pipeline, so no such buttons exist.
 *
 * Adjust mode (`[data-crop-adjust]`) shows the original photo + SVG quad +
 * EIGHT handles: 4 corners `[data-crop-handle="tl|tr|br|bl"]`
 * (role=slider, arrows 1px / Shift-10px, pointer drag) and 4 edge midpoints
 * `[data-crop-handle-mid="top|right|bottom|left"]`. A midpoint drag
 * translates its WHOLE edge rigidly — both adjacent corners by one clamped
 * delta (clamp the DELTA so both corners stay in bounds, edge never shears),
 * then convexity-checked like a corner move (D32 semantics). Apply emits the
 * 8-point quad as 4 corners — midpoints are derived, never stored.
 *
 * Content-box-exact overlay: the photo renders `object-contain` (never
 * cropped), so a wide/tall frame letterboxes it. The SVG quad + handles are
 * positioned STRICTLY inside the computed `object-contain` content rect
 * (`containContentRect` from frame box + natural aspect — the single source
 * of truth shared by render positioning and `clientToImage` drag mapping),
 * never full-frame %. Handle hit targets stay 44px (a11y) while the visual
 * dot scales with display size. The quad maps 1:1 to displayed pixels.
 *
 * Compact action bar: primary `Apply` (adjust mode only) plus ONE
 * icon-button row (Adjust / Reset, Re-detect, Use original, Discard). Icons
 * are visible SVGs; each icon button keeps its EXACT text label inside a
 * `<span className="sr-only">` so `textContent` matching (unit + E2E) is
 * byte-identical. All stay real `<button>`s with aria-labels, 44px targets,
 * and unchanged disabled states (`[data-redetect]` kept).
 *
 * Runtime-dependency-free: no scanic worker/client import (type-only
 * `ScanicCorners` from `./scan/index`), pointer drag on the overlay
 * coordinate space with clamp + convex-guard, arrow-key stepping on all
 * handles (1px, Shift = 10px). The parent portals this card; no portals,
 * no `AnimatePresence` inside.
 *
 * DOM contract (E2E continuity):
 * - result `[data-crop-result]` + EXACTLY ONE `img [data-crop-result-img]`
 *   (`key={warpedUrl}` reactive src),
 * - adjust `[data-crop-adjust]` (original photo + SVG quad + 8 handles),
 * - progress `p [data-review-progress]`, re-detect `[data-redetect]`.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ScanicCorners } from './scan/index';

export interface ScanicReviewProps {
  photoUrl: string;
  imageWidth: number;
  imageHeight: number;
  corners: ScanicCorners | null;
  warpedUrl: string | null;
  detecting: boolean;
  note: string | null;
  pageLabel: string;
  progressLabel: string;
  /**
   * Parent-owned verdict — the single source of truth for warped-vs-original.
   * The card never keeps its own copy: it renders from this prop and reports
   * taps through `onUseOriginal`, so a toggle-back from the parent can never
   * desync the hero (a local flag would stick on the photo forever).
   */
  verdict: 'warped' | 'original';
  onAdjustApply(corners: ScanicCorners): void;
  onUseOriginal(): void;
  onDiscard(): void;
  onRedetect(): void;
  redetecting: boolean;
}

type HandleKey = 'tl' | 'tr' | 'br' | 'bl';
type CornerName = keyof ScanicCorners;
type MidEdge = 'top' | 'right' | 'bottom' | 'left';

const HANDLE_TO_CORNER: Record<HandleKey, CornerName> = {
  tl: 'topLeft',
  tr: 'topRight',
  br: 'bottomRight',
  bl: 'bottomLeft',
};

const CORNER_LABEL: Record<CornerName, string> = {
  topLeft: 'Top-left corner',
  topRight: 'Top-right corner',
  bottomRight: 'Bottom-right corner',
  bottomLeft: 'Bottom-left corner',
};

/** Each midpoint owns its whole edge: both adjacent corners move together. */
const EDGE_CORNERS: Record<MidEdge, [CornerName, CornerName]> = {
  top: ['topLeft', 'topRight'],
  right: ['topRight', 'bottomRight'],
  bottom: ['bottomRight', 'bottomLeft'],
  left: ['bottomLeft', 'topLeft'],
};

const MID_LABEL: Record<MidEdge, string> = {
  top: 'Top edge',
  right: 'Right edge',
  bottom: 'Bottom edge',
  left: 'Left edge',
};

const MID_EDGES: MidEdge[] = ['top', 'right', 'bottom', 'left'];

function fullFrameCorners(w: number, h: number): ScanicCorners {
  const width = Math.max(1, Math.floor(w) || 0) || 1;
  const height = Math.max(1, Math.floor(h) || 0) || 1;
  return {
    topLeft: { x: 0, y: 0 },
    topRight: { x: width, y: 0 },
    bottomRight: { x: width, y: height },
    bottomLeft: { x: 0, y: height },
  };
}

function cloneCorners(corners: ScanicCorners): ScanicCorners {
  return {
    topLeft: { ...corners.topLeft },
    topRight: { ...corners.topRight },
    bottomRight: { ...corners.bottomRight },
    bottomLeft: { ...corners.bottomLeft },
  };
}

/**
 * `object-contain` content rect of the photo inside its frame — the single
 * source of truth shared by overlay render positioning and `clientToImage`
 * drag mapping. Never reads black bars as photo pixels.
 */
export function containContentRect(
  frameW: number,
  frameH: number,
  naturalW: number,
  naturalH: number,
): { left: number; top: number; width: number; height: number } {
  const fw = Math.max(0, frameW);
  const fh = Math.max(0, frameH);
  const nw = Math.max(1, naturalW);
  const nh = Math.max(1, naturalH);
  if (fw === 0 || fh === 0) return { left: 0, top: 0, width: fw, height: fh };
  const scale = Math.min(fw / nw, fh / nh);
  const width = nw * scale;
  const height = nh * scale;
  return { left: (fw - width) / 2, top: (fh - height) / 2, width, height };
}

/** Strictly convex (same-sign turns, non-zero area) in TL→TR→BR→BL order. */
function isConvexQuad(corners: ScanicCorners): boolean {
  const pts = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

function clampPoint(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(Math.round(x), 0), Math.max(1, w)),
    y: Math.min(Math.max(Math.round(y), 0), Math.max(1, h)),
  };
}

export const LOUPE_SIZE = 96;
export const LOUPE_ZOOM = 1.6;
const LOUPE_OFFSET = 16;

/**
 * Source rect (natural image pixels) for the 1.6x loupe, centered EXACTLY
 * on the active corner. Accuracy contract: rect center == corner position
 * (before edge clamping); clamping only shifts the rect to stay in bounds.
 */
export function loupeSourceRect(
  cornerX: number,
  cornerY: number,
  imgW: number,
  imgH: number,
  loupeSize: number = LOUPE_SIZE,
  zoom: number = LOUPE_ZOOM,
): { sx: number; sy: number; sw: number; sh: number } {
  const safeW = Math.max(1, imgW);
  const safeH = Math.max(1, imgH);
  const size = Math.max(1, loupeSize);
  const z = zoom > 0 ? zoom : 1;
  const sw = Math.min(safeW, size / z);
  const sh = Math.min(safeH, size / z);
  const rawSx = cornerX - sw / 2;
  const rawSy = cornerY - sh / 2;
  return {
    sx: Math.min(Math.max(rawSx, 0), Math.max(0, safeW - sw)),
    sy: Math.min(Math.max(rawSy, 0), Math.max(0, safeH - sh)),
    sw,
    sh,
  };
}

/**
 * Loupe frame position: above-left of the active display point (clear of
 * the finger), clamped inside the hero frame.
 */
export function loupePosition(
  displayX: number,
  displayY: number,
  frameW: number,
  frameH: number,
  size: number = LOUPE_SIZE,
  offset: number = LOUPE_OFFSET,
): { left: number; top: number } {
  if (frameW <= 0 || frameH <= 0) return { left: 8, top: 8 };
  const maxLeft = Math.max(0, frameW - size);
  const maxTop = Math.max(0, frameH - size);
  return {
    left: Math.min(Math.max(displayX - size - offset, 0), maxLeft),
    top: Math.min(Math.max(displayY - size - offset, 0), maxTop),
  };
}

function quadPointsAttr(corners: ScanicCorners): string {
  return (
    `${corners.topLeft.x},${corners.topLeft.y} ` +
    `${corners.topRight.x},${corners.topRight.y} ` +
    `${corners.bottomRight.x},${corners.bottomRight.y} ` +
    `${corners.bottomLeft.x},${corners.bottomLeft.y}`
  );
}

export default function ScanicReview({
  photoUrl,
  imageWidth,
  imageHeight,
  corners,
  warpedUrl,
  detecting,
  note,
  pageLabel,
  progressLabel,
  onAdjustApply,
  onUseOriginal,
  onDiscard,
  onRedetect,
  redetecting,
  verdict,
}: ScanicReviewProps) {
  const [adjusting, setAdjusting] = useState(false);
  const [draft, setDraft] = useState<ScanicCorners | null>(null);
  const [frameBox, setFrameBox] = useState<{ w: number; h: number } | null>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const photoImgRef = useRef<HTMLImageElement>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCacheRef = useRef(new Map<string, HTMLImageElement>());
  const [grabbed, setGrabbed] = useState<{
    kind: 'corner' | 'mid';
    key: HandleKey | MidEdge;
  } | null>(null);
  const [focusedHandle, setFocusedHandle] = useState<{
    kind: 'corner' | 'mid';
    key: HandleKey | MidEdge;
  } | null>(null);
  const dragKeyRef = useRef<HandleKey | null>(null);
  const midDragRef = useRef<{
    edge: MidEdge;
    startX: number;
    startY: number;
    snapshot: ScanicCorners;
  } | null>(null);

  // New page = fresh seed: leave no adjust state behind. The warped/original
  // verdict lives in the parent (`verdict` prop) — never mirrored locally.
  useEffect(() => {
    setAdjusting(false);
    setDraft(null);
    setGrabbed(null);
    setFocusedHandle(null);
  }, [photoUrl]);

  // Measure the adjust frame so the overlay can use content-box-exact rects.
  // ResizeObserver + window resize cover real browsers; the every-render
  // check catches letterboxed mocks applied after mount in tests.
  useEffect(() => {
    if (!adjusting) {
      setFrameBox(null);
      return;
    }
    const host = heroRef.current;
    const read = (): void => {
      const el = heroRef.current;
      if (el === null) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setFrameBox((prev) => {
          if (
            prev !== null &&
            Math.abs(prev.w - rect.width) < 0.5 &&
            Math.abs(prev.h - rect.height) < 0.5
          ) {
            return prev;
          }
          return { w: rect.width, h: rect.height };
        });
      }
    };
    read();
    const onResize = (): void => {
      read();
    };
    window.addEventListener('resize', onResize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && host !== null) {
      ro = new ResizeObserver(onResize);
      ro.observe(host);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [adjusting]);

  // Re-check after every render while adjusting (test mocks + layout shifts).
  useEffect(() => {
    if (!adjusting) return;
    const host = heroRef.current;
    if (host === null) return;
    const rect = host.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setFrameBox((prev) => {
        if (
          prev !== null &&
          Math.abs(prev.w - rect.width) < 0.5 &&
          Math.abs(prev.h - rect.height) < 0.5
        ) {
          return prev;
        }
        return { w: rect.width, h: rect.height };
      });
    }
  });

  const safeW = imageWidth > 0 ? imageWidth : 1;
  const safeH = imageHeight > 0 ? imageHeight : 1;

  const contentRect =
    frameBox !== null && frameBox.w > 0 && frameBox.h > 0
      ? containContentRect(frameBox.w, frameBox.h, safeW, safeH)
      : null;
  const contentMin = contentRect !== null ? Math.min(contentRect.width, contentRect.height) : 0;
  // Proportionate visual dot (14–20px); the 44px hit target is preserved via padding.
  const handleVisual = Math.min(20, Math.max(14, contentMin * 0.07));

  const enterAdjust = () => {
    setDraft(cloneCorners(corners ?? fullFrameCorners(safeW, safeH)));
    setAdjusting(true);
    setGrabbed(null);
    setFocusedHandle(null);
  };
  const cancelAdjust = () => {
    setAdjusting(false);
    setDraft(null);
    setGrabbed(null);
    setFocusedHandle(null);
  };

  const moveCorner = (key: HandleKey, x: number, y: number) => {
    const corner = HANDLE_TO_CORNER[key];
    setDraft((prev) => {
      if (prev === null) return prev;
      const clamped = clampPoint(x, y, safeW, safeH);
      const next: ScanicCorners = { ...cloneCorners(prev), [corner]: clamped };
      // Convex-guard: reject moves that fold or collapse the quad.
      if (!isConvexQuad(next)) return prev;
      return next;
    });
  };

  const stepCorner = (key: HandleKey, dx: number, dy: number) => {
    const corner = HANDLE_TO_CORNER[key];
    setDraft((prev) => {
      if (prev === null) return prev;
      const p = prev[corner];
      const clamped = clampPoint(p.x + dx, p.y + dy, safeW, safeH);
      const next: ScanicCorners = { ...cloneCorners(prev), [corner]: clamped };
      if (!isConvexQuad(next)) return prev;
      return next;
    });
  };

  /**
   * Clamp a WHOLE-EDGE delta so BOTH corners stay in bounds. Clamping the
   * delta (not each corner) keeps the edge rigid — it never shears.
   */
  const clampEdgeDelta = (
    c1: { x: number; y: number },
    c2: { x: number; y: number },
    dx: number,
    dy: number,
  ): { dx: number; dy: number } => {
    const dxMin = -Math.min(c1.x, c2.x);
    const dxMax = safeW - Math.max(c1.x, c2.x);
    const dyMin = -Math.min(c1.y, c2.y);
    const dyMax = safeH - Math.max(c1.y, c2.y);
    return {
      dx: Math.min(Math.max(Math.round(dx), dxMin), dxMax),
      dy: Math.min(Math.max(Math.round(dy), dyMin), dyMax),
    };
  };

  /** Midpoint drag: rigid whole-edge translate from the drag-start snapshot. */
  const moveMid = (edge: MidEdge, x: number, y: number) => {
    const drag = midDragRef.current;
    if (drag === null || drag.edge !== edge) return;
    const [n1, n2] = EDGE_CORNERS[edge];
    const c1 = drag.snapshot[n1];
    const c2 = drag.snapshot[n2];
    const c = clampEdgeDelta(c1, c2, x - drag.startX, y - drag.startY);
    if (c.dx === 0 && c.dy === 0) return;
    setDraft((prev) => {
      if (prev === null) return prev;
      const next = cloneCorners(prev);
      next[n1] = { x: c1.x + c.dx, y: c1.y + c.dy };
      next[n2] = { x: c2.x + c.dx, y: c2.y + c.dy };
      // Convex-guard: reject moves that fold or collapse the quad.
      if (!isConvexQuad(next)) return prev;
      return next;
    });
  };

  /** Midpoint keyboard nudge: same rigid translate, one step at a time. */
  const stepMid = (edge: MidEdge, dx: number, dy: number) => {
    const [n1, n2] = EDGE_CORNERS[edge];
    setDraft((prev) => {
      if (prev === null) return prev;
      const c = clampEdgeDelta(prev[n1], prev[n2], dx, dy);
      if (c.dx === 0 && c.dy === 0) return prev;
      const next = cloneCorners(prev);
      next[n1] = { x: prev[n1].x + c.dx, y: prev[n1].y + c.dy };
      next[n2] = { x: prev[n2].x + c.dx, y: prev[n2].y + c.dy };
      if (!isConvexQuad(next)) return prev;
      return next;
    });
  };

  const clientToImage = (clientX: number, clientY: number): { x: number; y: number } => {
    const host = heroRef.current;
    if (host === null) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    // SAME content rect as render: never map black-bar pixels to image space.
    const content = containContentRect(rect.width, rect.height, safeW, safeH);
    if (content.width === 0 || content.height === 0) return { x: 0, y: 0 };
    const cx = clientX - rect.left - content.left;
    const cy = clientY - rect.top - content.top;
    return {
      x: (cx / content.width) * safeW,
      y: (cy / content.height) * safeH,
    };
  };

  const applyDraft = () => {
    if (draft !== null) onAdjustApply(cloneCorners(draft));
    setAdjusting(false);
    setDraft(null);
    setGrabbed(null);
    setFocusedHandle(null);
    // A fresh warp follows: the processed result is the hero again.
    // (No local verdict flag to clear — the parent owns the verdict and
    // re-warps on Apply, so the hero follows the fresh `warpedUrl`.)
  };

  const chooseOriginal = () => {
    setAdjusting(false);
    setDraft(null);
    onUseOriginal();
  };

  const redetect = () => {
    onRedetect();
  };

  const verdictDisabled = detecting;

  const midPoint = (edge: MidEdge): { x: number; y: number } | null => {
    if (draft === null) return null;
    const [n1, n2] = EDGE_CORNERS[edge];
    return {
      x: (draft[n1].x + draft[n2].x) / 2,
      y: (draft[n1].y + draft[n2].y) / 2,
    };
  };

  const overlaySvgStyle: CSSProperties | undefined =
    contentRect !== null
      ? {
          left: contentRect.left,
          top: contentRect.top,
          width: contentRect.width,
          height: contentRect.height,
        }
      : undefined;

  const handlePosStyle = (x: number, y: number): CSSProperties => {
    if (contentRect !== null) {
      return {
        left: contentRect.left + (x / safeW) * contentRect.width,
        top: contentRect.top + (y / safeH) * contentRect.height,
        touchAction: 'none',
      };
    }
    return {
      left: `${(x / safeW) * 100}%`,
      top: `${(y / safeH) * 100}%`,
      touchAction: 'none',
    };
  };

  // Loupe: visible while any handle is grabbed OR has keyboard focus.
  const loupeHandle = grabbed ?? focusedHandle;
  const loupeImagePoint: { x: number; y: number } | null =
    adjusting && draft !== null && loupeHandle !== null
      ? loupeHandle.kind === 'corner'
        ? draft[HANDLE_TO_CORNER[loupeHandle.key as HandleKey]]
        : midPoint(loupeHandle.key as MidEdge)
      : null;
  const loupeDisplayPoint: { x: number; y: number } | null =
    loupeImagePoint !== null && contentRect !== null
      ? {
          x: contentRect.left + (loupeImagePoint.x / safeW) * contentRect.width,
          y: contentRect.top + (loupeImagePoint.y / safeH) * contentRect.height,
        }
      : null;
  const loupeBox =
    loupeImagePoint !== null
      ? frameBox !== null && loupeDisplayPoint !== null
        ? loupePosition(loupeDisplayPoint.x, loupeDisplayPoint.y, frameBox.w, frameBox.h)
        : { left: 8, top: 8 }
      : null;

  // Cache the source bitmap per photoUrl; jsdom-safe (never throws).
  useEffect(() => {
    try {
      if (sourceCacheRef.current.has(photoUrl)) return;
      if (typeof Image === 'undefined') return;
      const img = new Image();
      img.src = photoUrl;
      sourceCacheRef.current.set(photoUrl, img);
    } catch {
      // No-cache fallback: draw directly from the rendered photo element.
    }
  }, [photoUrl]);

  // Paint the 1.6x zoom centered EXACTLY on the active corner. Guards make
  // jsdom / no-canvas environments degrade to lens-frame-with-crosshair.
  useEffect(() => {
    if (loupeImagePoint === null || loupeHandle === null) return;
    try {
      // Resolve pixels first so jsdom (naturalWidth 0) returns before
      // touching canvas at all — no getContext noise, no crash.
      const cached = sourceCacheRef.current.get(photoUrl);
      const rendered = photoImgRef.current;
      const source =
        cached !== undefined && cached.complete && cached.naturalWidth > 0 ? cached : rendered;
      if (source === null || source === undefined) return;
      const natW = source.naturalWidth ?? 0;
      const natH = source.naturalHeight ?? 0;
      if (natW === 0 || natH === 0) return;
      const canvas = loupeCanvasRef.current;
      if (canvas === null) return;
      if (typeof canvas.getContext !== 'function') return;
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = canvas.getContext('2d');
      } catch {
        return;
      }
      if (ctx === null || ctx === undefined) return;
      // Draft corners live in source pixel space (safeW/safeH == natural
      // size); scale to the bitmap's actual natural size for exact centering.
      const scaleX = natW / safeW;
      const scaleY = natH / safeH;
      const r = loupeSourceRect(loupeImagePoint.x * scaleX, loupeImagePoint.y * scaleY, natW, natH);
      try {
        ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
        ctx.drawImage(source, r.sx, r.sy, r.sw, r.sh, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
      } catch {
        // Canvas without bitmap support (jsdom): keep the lens frame.
      }
    } catch {
      // Never crash the review card for a magnifier failure.
    }
  });

  return (
    <div className="max-h-[100dvh] space-y-3 overflow-y-auto p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-medium text-ink-700 dark:text-paper-100">{pageLabel}</p>
        <p
          data-review-progress
          aria-label={progressLabel}
          className="text-xs tabular-nums text-ink-400 dark:text-ink-300"
        >
          {progressLabel}
        </p>
      </div>

      {/* Single canvas: adjust mode edits the photo; otherwise the result view
          shows ONLY the warped auto-crop (one img, never a second canvas). */}
      {adjusting && draft !== null ? (
        <div
          ref={heroRef}
          data-crop-adjust
          className="relative overflow-hidden rounded-xl bg-ink-950"
        >
          <img
            ref={photoImgRef}
            src={photoUrl}
            alt="Original photo with adjustable crop outline"
            className="block max-h-[50dvh] w-full object-contain"
            draggable={false}
          />
          <svg
            viewBox={`0 0 ${safeW} ${safeH}`}
            preserveAspectRatio="none"
            aria-hidden={false}
            aria-label="Adjustable crop outline"
            style={overlaySvgStyle}
            className={
              contentRect !== null
                ? 'pointer-events-none absolute'
                : 'pointer-events-none absolute inset-0 h-full w-full'
            }
          >
            <path
              d={
                `M0 0H${safeW}V${safeH}H0Z ` +
                `M${draft.topLeft.x} ${draft.topLeft.y}` +
                `L${draft.topRight.x} ${draft.topRight.y}` +
                `L${draft.bottomRight.x} ${draft.bottomRight.y}` +
                `L${draft.bottomLeft.x} ${draft.bottomLeft.y}Z`
              }
              fill="rgba(23, 19, 14, 0.55)"
              fillRule="evenodd"
            />
            <polygon
              points={quadPointsAttr(draft)}
              fill="none"
              stroke="#c97a1f"
              strokeWidth={Math.max(safeW, safeH) * 0.004}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {(['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const).map((name) => (
              <circle
                key={name}
                cx={draft[name].x}
                cy={draft[name].y}
                r={Math.max(safeW, safeH) * 0.008}
                fill="#fdfbf7"
                stroke="#c97a1f"
                strokeWidth={Math.max(safeW, safeH) * 0.003}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {MID_EDGES.map((edge) => {
              const [n1, n2] = EDGE_CORNERS[edge];
              return (
                <circle
                  key={edge}
                  cx={(draft[n1].x + draft[n2].x) / 2}
                  cy={(draft[n1].y + draft[n2].y) / 2}
                  r={Math.max(safeW, safeH) * 0.006}
                  fill="#c97a1f"
                  stroke="#fdfbf7"
                  strokeWidth={Math.max(safeW, safeH) * 0.002}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
          <div className="absolute inset-0">
            {(Object.keys(HANDLE_TO_CORNER) as HandleKey[]).map((key) => {
              const corner = HANDLE_TO_CORNER[key];
              const point = draft[corner];
              const pctX = safeW > 0 ? Math.round((point.x / safeW) * 100) : 0;
              const pctY = safeH > 0 ? Math.round((point.y / safeH) * 100) : 0;
              return (
                <button
                  key={key}
                  type="button"
                  data-crop-handle={key}
                  role="slider"
                  aria-label={CORNER_LABEL[corner]}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pctX}
                  aria-valuetext={`${pctX} percent across, ${pctY} percent down`}
                  style={handlePosStyle(point.x, point.y)}
                  className="absolute inline-flex h-11 w-11 min-h-[44px] min-w-[44px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-transparent text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brass-400"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    dragKeyRef.current = key;
                    setGrabbed({ kind: 'corner', key });
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      // jsdom / browsers without pointer capture: move
                      // events still fire on the element while pressed.
                    }
                  }}
                  onPointerMove={(e) => {
                    if (dragKeyRef.current !== key) return;
                    if (e.buttons !== undefined && e.buttons !== 0 && e.buttons !== 1) return;
                    const p = clientToImage(e.clientX, e.clientY);
                    moveCorner(key, p.x, p.y);
                  }}
                  onPointerUp={() => {
                    dragKeyRef.current = null;
                    setGrabbed((prev) =>
                      prev !== null && prev.kind === 'corner' && prev.key === key ? null : prev,
                    );
                  }}
                  onPointerCancel={() => {
                    dragKeyRef.current = null;
                    setGrabbed((prev) =>
                      prev !== null && prev.kind === 'corner' && prev.key === key ? null : prev,
                    );
                  }}
                  onFocus={() => setFocusedHandle({ kind: 'corner', key })}
                  onBlur={() =>
                    setFocusedHandle((prev) =>
                      prev !== null && prev.kind === 'corner' && prev.key === key ? null : prev,
                    )
                  }
                  onKeyDown={(e) => {
                    const delta = e.shiftKey ? 10 : 1;
                    if (e.key === 'ArrowLeft') {
                      e.preventDefault();
                      stepCorner(key, -delta, 0);
                    } else if (e.key === 'ArrowRight') {
                      e.preventDefault();
                      stepCorner(key, delta, 0);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      stepCorner(key, 0, -delta);
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      stepCorner(key, 0, delta);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelAdjust();
                    }
                  }}
                >
                  <span
                    aria-hidden
                    className="inline-flex items-center justify-center rounded-full border-2 border-dotted border-brass-400 bg-paper-50/25 shadow-soft"
                    style={{ width: handleVisual, height: handleVisual }}
                  >
                    <span
                      aria-hidden
                      className="rounded-full bg-brass-400"
                      style={{ width: 4, height: 4 }}
                    />
                  </span>
                </button>
              );
            })}
            {MID_EDGES.map((edge) => {
              const mid = midPoint(edge);
              if (mid === null) return null;
              const pctX = safeW > 0 ? Math.round((mid.x / safeW) * 100) : 0;
              const pctY = safeH > 0 ? Math.round((mid.y / safeH) * 100) : 0;
              return (
                <button
                  key={`mid-${edge}`}
                  type="button"
                  data-crop-handle-mid={edge}
                  role="slider"
                  aria-label={MID_LABEL[edge]}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pctX}
                  aria-valuetext={`${pctX} percent across, ${pctY} percent down`}
                  style={handlePosStyle(mid.x, mid.y)}
                  className="absolute inline-flex h-11 w-11 min-h-[44px] min-w-[44px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md bg-transparent text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brass-400"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (draft === null) return;
                    const p = clientToImage(e.clientX, e.clientY);
                    midDragRef.current = {
                      edge,
                      startX: p.x,
                      startY: p.y,
                      snapshot: cloneCorners(draft),
                    };
                    setGrabbed({ kind: 'mid', key: edge });
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      // jsdom / browsers without pointer capture.
                    }
                  }}
                  onPointerMove={(e) => {
                    if (midDragRef.current?.edge !== edge) return;
                    if (e.buttons !== undefined && e.buttons !== 0 && e.buttons !== 1) return;
                    const p = clientToImage(e.clientX, e.clientY);
                    moveMid(edge, p.x, p.y);
                  }}
                  onPointerUp={() => {
                    if (midDragRef.current?.edge === edge) midDragRef.current = null;
                    setGrabbed((prev) =>
                      prev !== null && prev.kind === 'mid' && prev.key === edge ? null : prev,
                    );
                  }}
                  onPointerCancel={() => {
                    if (midDragRef.current?.edge === edge) midDragRef.current = null;
                    setGrabbed((prev) =>
                      prev !== null && prev.kind === 'mid' && prev.key === edge ? null : prev,
                    );
                  }}
                  onFocus={() => setFocusedHandle({ kind: 'mid', key: edge })}
                  onBlur={() =>
                    setFocusedHandle((prev) =>
                      prev !== null && prev.kind === 'mid' && prev.key === edge ? null : prev,
                    )
                  }
                  onKeyDown={(e) => {
                    const delta = e.shiftKey ? 10 : 1;
                    if (e.key === 'ArrowLeft') {
                      e.preventDefault();
                      stepMid(edge, -delta, 0);
                    } else if (e.key === 'ArrowRight') {
                      e.preventDefault();
                      stepMid(edge, delta, 0);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      stepMid(edge, 0, -delta);
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      stepMid(edge, 0, delta);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelAdjust();
                    }
                  }}
                >
                  <span
                    aria-hidden
                    className="inline-flex items-center justify-center rounded-[3px] border-2 border-dotted border-brass-400 bg-paper-50/25 shadow-soft"
                    style={{ width: handleVisual, height: handleVisual }}
                  >
                    <span
                      aria-hidden
                      className="rounded-full bg-brass-400"
                      style={{ width: 4, height: 4 }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
          {loupeBox !== null && loupeImagePoint !== null && (
            <div
              data-loupe
              aria-hidden="true"
              className="pointer-events-none absolute z-10 overflow-hidden rounded-full border-2 border-brass-400 bg-ink-950 shadow-soft"
              style={{
                left: loupeBox.left,
                top: loupeBox.top,
                width: LOUPE_SIZE,
                height: LOUPE_SIZE,
              }}
            >
              <canvas
                ref={loupeCanvasRef}
                width={LOUPE_SIZE}
                height={LOUPE_SIZE}
                className="block h-full w-full rounded-full"
              />
              <div data-loupe-crosshair className="pointer-events-none absolute inset-0">
                <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-brass-400/90" />
                <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-brass-400/90" />
                <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brass-400" />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div data-crop-result className="relative overflow-hidden rounded-xl bg-ink-950">
          {detecting ? (
            <p
              role="status"
              className="flex min-h-56 items-center justify-center text-sm text-paper-100"
            >
              Preparing…
            </p>
          ) : verdict === 'original' ? (
            <>
              <img
                key="original"
                data-crop-result-img
                src={photoUrl}
                alt="Original photo — unprocessed"
                className="block max-h-[50dvh] w-full object-contain"
                draggable={false}
              />
              <p className="absolute left-3 top-3 rounded-full bg-ink-950/80 px-3 py-1 text-xs font-medium text-paper-50">
                Original photo — unprocessed
              </p>
            </>
          ) : warpedUrl !== null ? (
            <>
              <img
                key={warpedUrl}
                data-crop-result-img
                src={warpedUrl}
                alt="Auto-crop result preview"
                className="block max-h-[50dvh] w-full object-contain"
                draggable={false}
              />
              {corners === null && (
                <p className="px-4 py-2 text-center text-xs text-paper-100/90">
                  Auto-detect found no page — adjust to crop manually.
                </p>
              )}
            </>
          ) : corners === null ? (
            // No detection and no warp yet: show the ORIGINAL photo as the
            // single canvas (same one-img contract) with the honest caption.
            // A review with no image is a dead end — waitForResultImg,
            // adjust seeding, and the user's own eyes all need pixels.
            // (Distinct from the Use-original verdict above: no chip here.)
            <>
              <img
                key="photo-fallback"
                data-crop-result-img
                src={photoUrl}
                alt="Original photo — no auto-crop found"
                className="block max-h-[50dvh] w-full object-contain"
                draggable={false}
              />
              <p className="px-4 py-2 text-center text-xs text-paper-100/90">
                Auto-detect found no page — adjust to crop manually.
              </p>
            </>
          ) : (
            <p
              role="status"
              className="flex min-h-56 items-center justify-center px-4 py-8 text-center text-xs text-paper-100/70"
            >
              Processing auto-crop…
            </p>
          )}
        </div>
      )}
      {note !== null && <p className="text-xs text-ink-400 dark:text-ink-300">{note}</p>}

      {adjusting && (
        <p className="text-xs text-ink-400 dark:text-ink-300">
          Drag a handle or focus one and use the arrow keys (Shift for larger steps). Escape
          cancels.
        </p>
      )}

      <div className="space-y-2">
        {adjusting && (
          <button
            type="button"
            onClick={applyDraft}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
          >
            Apply
          </button>
        )}
        <div className="grid grid-cols-4 gap-2" role="group" aria-label="Review actions">
          {!adjusting ? (
            <button
              type="button"
              aria-label="Adjust corners"
              disabled={verdictDisabled}
              onClick={enterAdjust}
              className="inline-flex h-11 min-h-[44px] w-full min-w-[44px] items-center justify-center rounded-xl border border-paper-300 text-ink-700 transition-colors hover:bg-paper-200 disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="h-5 w-5"
              >
                <path d="M6 2v14a2 2 0 0 0 2 2h14" />
                <path d="M2 6h14a2 2 0 0 1 2 2v14" />
              </svg>
              <span className="sr-only">Adjust corners</span>
            </button>
          ) : (
            <button
              type="button"
              aria-label="Reset to auto"
              disabled={corners === null}
              title={
                corners === null ? 'No auto-detection for this page' : 'Reseed from auto-detection'
              }
              onClick={() => {
                if (corners !== null) setDraft(cloneCorners(corners));
              }}
              className="inline-flex h-11 min-h-[44px] w-full min-w-[44px] items-center justify-center rounded-xl border border-paper-300 text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="h-5 w-5"
              >
                <path d="M3 12a9 9 0 1 0 2.64-6.36" />
                <path d="M3 3v6h6" />
              </svg>
              <span className="sr-only">Reset to auto</span>
            </button>
          )}
          <button
            type="button"
            aria-label="Re-detect"
            data-redetect
            disabled={redetecting}
            onClick={redetect}
            className="inline-flex h-11 min-h-[44px] w-full min-w-[44px] items-center justify-center rounded-xl border border-paper-300 text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-wait disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-5 w-5"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            <span className="sr-only">Re-detect</span>
          </button>
          <button
            type="button"
            aria-label="Use original"
            disabled={verdictDisabled}
            onClick={chooseOriginal}
            className="inline-flex h-11 min-h-[44px] w-full min-w-[44px] items-center justify-center rounded-xl border border-paper-300 text-ink-700 transition-colors hover:bg-paper-200 disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-5 w-5"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-4.5-4.5L6 21" />
            </svg>
            <span className="sr-only">Use original</span>
          </button>
          <button
            type="button"
            aria-label="Discard"
            onClick={onDiscard}
            className="inline-flex h-11 min-h-[44px] w-full min-w-[44px] items-center justify-center rounded-xl border border-red-600/30 text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:hover:bg-red-950/30"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-5 w-5"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
            <span className="sr-only">Discard</span>
          </button>
        </div>
      </div>
    </div>
  );
}
