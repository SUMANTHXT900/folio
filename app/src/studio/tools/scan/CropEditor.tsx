/**
 * Review-queue crop editor: the manual corner-adjustment page of the
 * document scanner's full-screen review queue (2026-10-02 UX
 * restructure).
 *
 * Every capture queues silently during shooting (see `useScanProcessor`)
 * and is reviewed later, ONE page at a time, here: the ORIGINAL photo
 * full-height in a contain rect (see `scanViewport.ts`) with an SVG quad
 * overlay seeded once from the auto `result.corners` (role-ordered
 * below), or a 90% inset rect when detection produced no corners —
 * fallback captures enter the queue too, so EVERY photo is croppable.
 * Per page: "Use crop" (full-res rewrap → commit processed page →
 * advance), "Use original" (commit as photo → advance), "Discard" (drop
 * → advance), and the header back arrow exits the queue.
 *
 * Interaction contract:
 * - Four draggable corner handles (pointer events, `touch-action: none`,
 *   44px targets). Roles TL/TR/BR/BL are fixed — the detected corner
 *   order is normalized ONCE at seed time and never re-run mid-drag
 *   (role swapping under the finger is the classic bug).
 * - Convexity is enforced on every move via a cross-product-sign check
 *   (TS port of the `validate_quad` idea): positions are clamped to the
 *   image bounds, convexity flips are rejected (the handle stays put).
 * - Keyboard steppers live on the same handles (`role="slider"`, arrow
 *   keys, Shift for large steps, `role="status"` announcements).
 * - Overlay-only feedback during drag (free polygon redraw — no worker
 *   traffic while the pointer is down); the parent fires the debounced
 *   re-warp preview on release / 300ms idle at ≤800px long edge.
 *
 * Loupe deliberately omitted: a long-press offset magnifier needs a
 * second pointer-tracked lens plus its own decode positioning, and the
 * overlay redraw + debounced warp preview already give exact placement
 * feedback. Revisit only if real-device testing shows misplacement.
 *
 * The QUEUE SURFACE is portaled to `document.body` (full-screen,
 * viewport-true) and is NEVER wrapped in `AnimatePresence` (known
 * codebase footgun: it swallows direct `createPortal()` children). The
 * editor itself renders inline inside that surface.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/ui';
import { useContainBox } from '../scanViewport';
import type { ScanCorner } from './scanWorkerClient';

export const CROP_HANDLE_ROLES = ['tl', 'tr', 'br', 'bl'] as const;
export type CropHandleRole = (typeof CROP_HANDLE_ROLES)[number];

/** Quad with fixed roles: [top-left, top-right, bottom-right, bottom-left]. */
export type CropQuad = [ScanCorner, ScanCorner, ScanCorner, ScanCorner];

const ROLE_LABEL: Record<CropHandleRole, string> = {
  tl: 'top-left',
  tr: 'top-right',
  br: 'bottom-right',
  bl: 'bottom-left',
};

/** Debounced preview delay after release / idle (spec: 300ms). */
const PREVIEW_DEBOUNCE_MS = 300;
/** Keyboard step in image pixels (Shift = fast step). */
const KEY_STEP = 4;
const KEY_STEP_FAST = 24;

/**
 * 90%-inset fallback rect (5% margin per side) for captures with
 * absent/unusable corners — including fallback (no-detection) captures,
 * which enter the queue croppable. Pure + deterministic.
 */
export function insetQuad(width: number, height: number): CropQuad {
  const ix = Math.max(0, width * 0.05);
  const iy = Math.max(0, height * 0.05);
  return [
    { x: ix, y: iy },
    { x: width - ix, y: iy },
    { x: width - ix, y: height - iy },
    { x: ix, y: height - iy },
  ];
}

/**
 * Normalizes four unordered detected points into fixed TL/TR/BR/BL
 * roles via the sum/difference heuristic (TL = min x+y, BR = max x+y,
 * TR = max x−y, BL = remainder). Runs ONCE at seed time — never
 * mid-drag. Returns null unless exactly four points arrive.
 */
export function orderCorners(points: ScanCorner[]): CropQuad | null {
  if (points.length !== 4) return null;
  const pool = points.map((p) => ({ x: p.x, y: p.y }));
  const takeIndex = (score: (p: ScanCorner) => number, wantMax: boolean): number => {
    let best = 0;
    for (let i = 1; i < pool.length; i += 1) {
      const better = wantMax
        ? score(pool[i]) > score(pool[best])
        : score(pool[i]) < score(pool[best]);
      if (better) best = i;
    }
    return best;
  };
  const tl = pool.splice(
    takeIndex((p) => p.x + p.y, false),
    1,
  )[0];
  const br = pool.splice(
    takeIndex((p) => p.x + p.y, true),
    1,
  )[0];
  const tr = pool.splice(
    takeIndex((p) => p.x - p.y, true),
    1,
  )[0];
  const [bl] = pool;
  return [tl, tr, br, bl];
}

/**
 * Strict convexity for a role-ordered quad: all edge-turn cross
 * products share one sign (non-zero area). Collinear runs are tolerated
 * (zero turns ignored); sign flips and degenerate quads fail.
 */
export function isConvexQuad(quad: ScanCorner[]): boolean {
  if (quad.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) {
      const s = Math.sign(cross);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return sign !== 0;
}

function withinBounds(quad: ScanCorner[], width: number, height: number): boolean {
  return quad.every((p) => p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height);
}

/** Seed once: ordered detection when usable, else the inset fallback. */
function seedQuad(initial: ScanCorner[] | null, width: number, height: number): CropQuad {
  const ordered = initial !== null ? orderCorners(initial) : null;
  if (ordered !== null && isConvexQuad(ordered) && withinBounds(ordered, width, height)) {
    return ordered;
  }
  return insetQuad(width, height);
}

export interface CropEditorProps {
  /**
   * Object URL of the ORIGINAL full-res capture (not the warped
   * preview). Owned by the review queue: minted at queue entry and
   * revoked on advance/discard/exit — never revoked here.
   */
  photoUrl: string;
  /** Full-res capture pixel dims — the quad coordinate space. */
  imageWidth: number;
  imageHeight: number;
  /** Auto-detected corners (unordered); null/absent → inset fallback. */
  initialCorners: ScanCorner[] | null;
  /** Debounced low-res re-warp preview URL (null until first idle). */
  cropPreviewUrl: string | null;
  cropPreviewPending: boolean;
  /** Full-res "Use crop" re-warp in flight. */
  applying: boolean;
  /** Fired on release / 300ms idle (never while dragging). */
  onPreviewRequest: (quad: CropQuad) => void;
  onUseCrop: (quad: CropQuad) => void;
  onUseOriginal: () => void;
  onDiscard: () => void;
}

export function CropEditor({
  photoUrl,
  imageWidth,
  imageHeight,
  initialCorners,
  cropPreviewUrl,
  cropPreviewPending,
  applying,
  onPreviewRequest,
  onUseCrop,
  onUseOriginal,
  onDiscard,
}: CropEditorProps) {
  // Seeded once per mount (the page remounts per queue entry, so a lazy
  // initializer is the seed — never re-seeded from props mid-edit).
  const [quad, setQuad] = useState<CropQuad>(() =>
    seedQuad(initialCorners, imageWidth, imageHeight),
  );
  const [dragging, setDragging] = useState(false);
  const quadRef = useRef(quad);
  quadRef.current = quad;
  const dragIndexRef = useRef<number | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const previewRef = useRef(onPreviewRequest);
  previewRef.current = onPreviewRequest;
  // Exact painted-frame mapping (same helper as the viewfinder): the
  // inner frame renders the contain rect, so client↔image conversion is
  // exact with no letterbox math.
  const viewport = useContainBox<HTMLDivElement>(imageWidth / imageHeight);

  const pointFromClient = (clientX: number, clientY: number): ScanCorner | null => {
    const el = frameRef.current;
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: ((clientX - r.left) / r.width) * imageWidth,
      y: ((clientY - r.top) / r.height) * imageHeight,
    };
  };

  /** Clamps to bounds, rejects convexity flips (handle stays put). */
  const moveCorner = (index: number, raw: ScanCorner): void => {
    const clamped = {
      x: Math.min(Math.max(raw.x, 0), imageWidth),
      y: Math.min(Math.max(raw.y, 0), imageHeight),
    };
    const next = [...quadRef.current] as CropQuad;
    next[index] = clamped;
    if (!isConvexQuad(next)) return;
    quadRef.current = next;
    setQuad(next);
  };

  const beginDrag =
    (index: number): React.PointerEventHandler<HTMLButtonElement> =>
    (e) => {
      // Window listeners (not pointer capture): robust for mouse, touch,
      // and pen alike — moves keep flowing even if the pointer leaves the
      // 44px target mid-drag.
      e.preventDefault();
      dragIndexRef.current = index;
      setDragging(true);
      const onMove = (ev: PointerEvent) => {
        const active = dragIndexRef.current;
        if (active === null) return;
        const pt = pointFromClient(ev.clientX, ev.clientY);
        if (pt !== null) moveCorner(active, pt);
      };
      const onUp = () => {
        dragIndexRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        // Release: the debounce effect below fires the preview request.
        setDragging(false);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };

  const stepCorner = (index: number, dx: number, dy: number): void => {
    const cur = quadRef.current[index];
    moveCorner(index, { x: cur.x + dx, y: cur.y + dy });
  };

  const onHandleKey =
    (index: number): React.KeyboardEventHandler<HTMLButtonElement> =>
    (e) => {
      const step = e.shiftKey ? KEY_STEP_FAST : KEY_STEP;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          stepCorner(index, -step, 0);
          break;
        case 'ArrowRight':
          e.preventDefault();
          stepCorner(index, step, 0);
          break;
        case 'ArrowUp':
          e.preventDefault();
          stepCorner(index, 0, -step);
          break;
        case 'ArrowDown':
          e.preventDefault();
          stepCorner(index, 0, step);
          break;
        default:
          return;
      }
    };

  // Debounced preview: skipped on mount (seed is not an edit) and while
  // dragging (overlay-only feedback); fires on release / 300ms idle.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (dragging) return;
    const id = window.setTimeout(() => {
      previewRef.current(quadRef.current);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [quad, dragging]);

  const polyPoints = quad.map((p) => `${p.x},${p.y}`).join(' ');
  const holePath = `M0 0H${imageWidth}V${imageHeight}H0Z M${quad[0].x} ${quad[0].y}L${quad[1].x} ${quad[1].y}L${quad[2].x} ${quad[2].y}L${quad[3].x} ${quad[3].y}Z`;

  return (
    <div data-crop-page className="flex min-h-0 flex-1 flex-col">
      {/* Photo LARGE (portrait full-height): the wrapper flexes to the
        leftover queue height and the frame is MEASURED (scanViewport) so
        photo and overlay share the exact painted rect. */}
      <div ref={viewport.ref} className="flex min-h-[12rem] flex-1 items-center justify-center">
        <div
          ref={frameRef}
          data-crop-frame
          className="relative overflow-hidden rounded-xl bg-ink-950"
          style={
            viewport.rect === null
              ? { width: '100%', aspectRatio: `${imageWidth} / ${imageHeight}` }
              : { width: `${viewport.rect.w}px`, height: `${viewport.rect.h}px` }
          }
        >
          <img
            src={photoUrl}
            alt="Original photo — drag the corner handles to the page edges"
            draggable={false}
            className="absolute inset-0 h-full w-full"
          />
          <svg
            aria-hidden
            viewBox={`0 0 ${imageWidth} ${imageHeight}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full text-brass-300"
          >
            {/* Dimmed surround with a quad hole (evenodd), same black/55 as the framing guide. */}
            <path d={holePath} fill="#000000" fillOpacity={0.55} fillRule="evenodd" />
            <polygon
              points={polyPoints}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {quad.map((pt, i) => {
            const role = CROP_HANDLE_ROLES[i];
            return (
              <button
                key={role}
                type="button"
                role="slider"
                data-crop-handle={role}
                aria-label={`Crop corner ${ROLE_LABEL[role]}`}
                aria-valuemin={0}
                aria-valuemax={Math.round(imageWidth)}
                aria-valuenow={Math.round(pt.x)}
                aria-valuetext={`${ROLE_LABEL[role]} corner at ${Math.round(pt.x)}, ${Math.round(pt.y)} of ${Math.round(imageWidth)} by ${Math.round(imageHeight)}`}
                onPointerDown={beginDrag(i)}
                onKeyDown={onHandleKey(i)}
                className="absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-300"
                style={{
                  left: `${(pt.x / imageWidth) * 100}%`,
                  top: `${(pt.y / imageHeight) * 100}%`,
                }}
              >
                <span
                  aria-hidden
                  className="h-5 w-5 rounded-full border-2 border-paper-50 bg-brass-500 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
                />
              </button>
            );
          })}
        </div>
      </div>
      {/* Screen-reader mirror of the quad geometry. */}
      <span role="status" className="sr-only">
        {`Crop corners: ${quad
          .map(
            (p, i) => `${ROLE_LABEL[CROP_HANDLE_ROLES[i]]} ${Math.round(p.x)}, ${Math.round(p.y)}`,
          )
          .join('; ')}`}
      </span>
      {(cropPreviewUrl !== null || cropPreviewPending) && (
        <div className="mt-2 flex items-center gap-2.5">
          {cropPreviewUrl !== null ? (
            <img
              src={cropPreviewUrl}
              alt="Adjusted scan preview"
              className="h-20 w-14 shrink-0 rounded-lg border border-paper-300 object-contain dark:border-ink-700"
            />
          ) : (
            <div
              aria-hidden
              className="h-20 w-14 shrink-0 animate-pulse rounded-lg bg-ink-950/10"
            />
          )}
          <p className="text-xs text-ink-400 dark:text-ink-300">
            {cropPreviewPending ? 'Updating preview…' : 'Preview of the adjusted crop.'}
          </p>
        </div>
      )}
      {/* Per-page decisions: every photo is croppable, every photo can be
        kept as shot, every photo can be dropped — then advance. */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          className="min-h-[44px]"
          onClick={() => onUseCrop(quadRef.current)}
          disabled={applying}
        >
          {applying ? 'Applying crop…' : 'Use crop'}
        </Button>
        <Button
          variant="ghost"
          className="min-h-[44px]"
          onClick={onUseOriginal}
          disabled={applying}
        >
          Use original
        </Button>
        <Button variant="danger" className="min-h-[44px]" onClick={onDiscard} disabled={applying}>
          Discard
        </Button>
      </div>
    </div>
  );
}

export interface ScanReviewQueueProps {
  /** Queue entry id — keys the page so each entry reseeds its quad. */
  entryId: number;
  /** 1-based position in the queue snapshot ("Page i of N"). */
  pageIndex: number;
  pageCount: number;
  /** The queue entry under review. */
  photoUrl: string;
  imageWidth: number;
  imageHeight: number;
  initialCorners: ScanCorner[] | null;
  cropPreviewUrl: string | null;
  cropPreviewPending: boolean;
  applying: boolean;
  onPreviewRequest: (quad: CropQuad) => void;
  onUseCrop: (quad: CropQuad) => void;
  onUseOriginal: () => void;
  onDiscard: () => void;
  /** Exits the queue (unreviewed entries commit as originals). */
  onBack: () => void;
}

/**
 * Full-screen review queue surface: one page at a time, photo large,
 * "Page i of N" header. Portaled to `document.body` so `fixed` is
 * viewport-true — NEVER wrapped in `AnimatePresence` (it swallows
 * direct portal children). 44px targets throughout; `dvh`-capped.
 */
export function ScanReviewQueue({
  entryId,
  pageIndex,
  pageCount,
  photoUrl,
  imageWidth,
  imageHeight,
  initialCorners,
  cropPreviewUrl,
  cropPreviewPending,
  applying,
  onPreviewRequest,
  onUseCrop,
  onUseOriginal,
  onDiscard,
  onBack,
}: ScanReviewQueueProps) {
  return createPortal(
    <div
      data-scan-queue
      className="fixed inset-0 z-[70] flex max-h-[100dvh] flex-col overscroll-contain bg-paper-50 dark:bg-ink-950"
    >
      {/* Queue header: back (exit queue) | "Page i of N". */}
      <div className="flex items-center gap-2 border-b border-paper-300/70 px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-ink-800/70">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to camera"
          title="Leave the review queue"
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-700"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back
        </button>
        <p
          role="status"
          className="min-w-0 flex-1 text-center text-sm font-medium text-ink-700 dark:text-paper-100"
        >
          Page {pageIndex} of {pageCount}
        </p>
        {/* Balance cell so the title stays optically centered. */}
        <span aria-hidden className="w-[62px] shrink-0" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
        <CropEditor
          key={entryId}
          photoUrl={photoUrl}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          initialCorners={initialCorners}
          cropPreviewUrl={cropPreviewUrl}
          cropPreviewPending={cropPreviewPending}
          applying={applying}
          onPreviewRequest={onPreviewRequest}
          onUseCrop={onUseCrop}
          onUseOriginal={onUseOriginal}
          onDiscard={onDiscard}
        />
      </div>
    </div>,
    document.body,
  );
}
