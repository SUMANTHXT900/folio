/**
 * ScanicReview — result-FIRST review card for one scanned page.
 *
 * The hero is the answer to the review complaint: the ORIGINAL photo with
 * the DETECTED QUAD drawn over it ("this is what ML found"), then the
 * user's verdict. The overlay derives from the `corners` prop on every
 * render, so a parent re-render with new corners/warpedUrl (after Apply or
 * Re-detect) updates the outline and the result strip with zero extra
 * wiring. Local state is only the in-progress adjust draft, reseeded from
 * `photoUrl` (a new page is a fresh seed).
 *
 * Runtime-dependency-free: no scanic worker/client import (type-only
 * `ScanicCorners` from `./scan/index`), pointer drag on the SVG-overlay
 * coordinate space with clamp + convex-guard, arrow-key stepping on the
 * handles (1px, Shift = 10px). The parent portals this card; no portals,
 * no `AnimatePresence` inside.
 *
 * DOM contract (E2E continuity):
 * - hero `[data-detect-overlay]` (SVG quad polygon + dimmed surround),
 * - result `[data-crop-result]` + `img [data-crop-result-img]`,
 * - handles `[data-crop-handle="tl|tr|br|bl"]` (role=slider),
 * - progress `p [data-review-progress]`, re-detect `[data-redetect]`.
 */

import { useEffect, useRef, useState } from 'react';
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
  onLooksGood(): void;
  onAdjustApply(corners: ScanicCorners): void;
  onUseOriginal(): void;
  onDiscard(): void;
  onRedetect(): void;
  redetecting: boolean;
}

type HandleKey = 'tl' | 'tr' | 'br' | 'bl';
type CornerName = keyof ScanicCorners;

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
  onLooksGood,
  onAdjustApply,
  onUseOriginal,
  onDiscard,
  onRedetect,
  redetecting,
}: ScanicReviewProps) {
  const [adjusting, setAdjusting] = useState(false);
  const [draft, setDraft] = useState<ScanicCorners | null>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const dragKeyRef = useRef<HandleKey | null>(null);

  // New page = fresh seed: leave no adjust state behind.
  useEffect(() => {
    setAdjusting(false);
    setDraft(null);
  }, [photoUrl]);

  const safeW = imageWidth > 0 ? imageWidth : 1;
  const safeH = imageHeight > 0 ? imageHeight : 1;

  const enterAdjust = () => {
    setDraft(cloneCorners(corners ?? fullFrameCorners(safeW, safeH)));
    setAdjusting(true);
  };
  const cancelAdjust = () => {
    setAdjusting(false);
    setDraft(null);
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

  const clientToImage = (clientX: number, clientY: number): { x: number; y: number } => {
    const host = heroRef.current;
    if (host === null) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * safeW,
      y: ((clientY - rect.top) / rect.height) * safeH,
    };
  };

  // The drawn outline: the live draft while adjusting, else the prop quad.
  // Post-Apply the parent re-renders with fresh `corners`, which is what
  // paints here — no extra wiring.
  const shown: ScanicCorners | null = adjusting ? draft : corners;
  const resultSrc = warpedUrl ?? photoUrl;

  const verdictDisabled = detecting;

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

      {/* Hero: original photo + ML-found outline. */}
      <div
        ref={heroRef}
        data-detect-overlay
        className="relative overflow-hidden rounded-xl bg-ink-950"
      >
        {detecting ? (
          <p
            role="status"
            className="flex min-h-56 items-center justify-center text-sm text-paper-100"
          >
            Preparing…
          </p>
        ) : (
          <>
            <img
              src={photoUrl}
              alt="Original capture with detected page outline"
              className="block max-h-[50dvh] w-full object-contain"
              draggable={false}
            />
            {shown !== null ? (
              <svg
                viewBox={`0 0 ${safeW} ${safeH}`}
                preserveAspectRatio="none"
                aria-hidden={!adjusting}
                aria-label={adjusting ? undefined : 'Detected page outline'}
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                <path
                  d={
                    `M0 0H${safeW}V${safeH}H0Z ` +
                    `M${shown.topLeft.x} ${shown.topLeft.y}` +
                    `L${shown.topRight.x} ${shown.topRight.y}` +
                    `L${shown.bottomRight.x} ${shown.bottomRight.y}` +
                    `L${shown.bottomLeft.x} ${shown.bottomLeft.y}Z`
                  }
                  fill="rgba(23, 19, 14, 0.55)"
                  fillRule="evenodd"
                />
                <polygon
                  points={quadPointsAttr(shown)}
                  fill="none"
                  stroke="#c97a1f"
                  strokeWidth={Math.max(safeW, safeH) * 0.004}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {(['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const).map((name) => (
                  <circle
                    key={name}
                    cx={shown[name].x}
                    cy={shown[name].y}
                    r={Math.max(safeW, safeH) * 0.008}
                    fill="#fdfbf7"
                    stroke="#c97a1f"
                    strokeWidth={Math.max(safeW, safeH) * 0.003}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
            ) : (
              <p className="px-4 py-2 text-center text-xs text-paper-100/90">
                Auto-detect found no page — adjust to crop manually.
              </p>
            )}
            {adjusting && draft !== null && (
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
                      style={{
                        left: `${(point.x / safeW) * 100}%`,
                        top: `${(point.y / safeH) * 100}%`,
                        touchAction: 'none',
                      }}
                      className="absolute inline-flex h-11 w-11 min-h-[44px] min-w-[44px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-brass-400 bg-paper-50 text-ink-900 shadow-soft"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        dragKeyRef.current = key;
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
                      }}
                      onPointerCancel={() => {
                        dragKeyRef.current = null;
                      }}
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
                      <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-brass-400" />
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      {/* Result strip: warped preview (reactive src; key forces re-decode). */}
      <div data-crop-result className="relative overflow-hidden rounded-xl bg-ink-950">
        {detecting ? (
          <p
            role="status"
            className="flex min-h-24 items-center justify-center text-sm text-paper-100"
          >
            Preparing…
          </p>
        ) : (
          <img
            key={warpedUrl}
            data-crop-result-img
            src={resultSrc}
            alt="Auto-crop result preview"
            className="mx-auto max-h-[40dvh] w-full object-contain"
            draggable={false}
          />
        )}
      </div>
      {note !== null && <p className="text-xs text-ink-400 dark:text-ink-300">{note}</p>}

      {adjusting && (
        <p className="text-xs text-ink-400 dark:text-ink-300">
          Drag a handle or focus one and use the arrow keys (Shift for larger steps). Escape
          cancels.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={verdictDisabled}
          onClick={onLooksGood}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 disabled:cursor-wait disabled:opacity-50 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
        >
          Looks good
        </button>
        {!adjusting ? (
          <button
            type="button"
            disabled={verdictDisabled}
            onClick={enterAdjust}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
          >
            Adjust corners
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                if (draft !== null) onAdjustApply(cloneCorners(draft));
                setAdjusting(false);
                setDraft(null);
              }}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-medium text-paper-50 transition-colors hover:bg-ink-800 dark:bg-paper-50 dark:text-ink-900 dark:hover:bg-paper-200"
            >
              Apply
            </button>
            <button
              type="button"
              disabled={corners === null}
              title={
                corners === null ? 'No auto-detection for this page' : 'Reseed from auto-detection'
              }
              onClick={() => {
                if (corners !== null) setDraft(cloneCorners(corners));
              }}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
            >
              Reset to auto
            </button>
          </>
        )}
        <button
          type="button"
          data-redetect
          disabled={redetecting}
          onClick={onRedetect}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:cursor-wait disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
        >
          Re-detect
        </button>
        <button
          type="button"
          disabled={verdictDisabled}
          onClick={onUseOriginal}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 disabled:opacity-40 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-700"
        >
          Use original
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-red-600/30 px-5 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:hover:bg-red-950/30"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
