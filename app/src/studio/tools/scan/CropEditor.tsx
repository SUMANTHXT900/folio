/**
 * Review-queue page reviewer — RESULT-FIRST (2026-10-03 UX pass).
 *
 * The hero of the review is the CROPPED RESULT, not the raw photo with a
 * quad. When a page is shown the preview is requested immediately
 * (`requestCropPreview`, ≤800px long edge) and rendered large on the
 * paper-white panel (`object-contain`, dvh-capped); while a newer preview
 * is in flight the last result stays visible under a subtle loading
 * scrim. Corner edits request a fresh preview on release / 300ms idle.
 *
 * Result mode (the default) actions — 44px targets, paper/ink/brass:
 * - "Looks good" (primary): commits the current quad via `useCrop`.
 * - "Adjust corners" (secondary): toggles into the photo + quad editor.
 * - "Use original" (small ghost): commits the capture as the photo.
 * - trash icon (aria-label "Discard page"): drops the page.
 *
 * Adjust mode: the ORIGINAL photo full-height in a contain rect (see
 * `scanViewport.ts`) with the SVG quad overlay seeded once from the auto
 * `result.corners` (role-ordered below), or a 90% inset rect when
 * detection produced no corners — fallback captures enter the queue too,
 * so EVERY photo is croppable. Instruction line, "Apply" (requests a
 * fresh preview + returns to the result view) and "Reset to auto"
 * (reseeds from `initialCorners`, disabled when detection found none).
 *
 * Interaction contract (8 handles — real-user request "adjustment only
 * has four dots; we should have many dots to adjust in different
 * direction/angle"):
 * - Four draggable corner handles (pointer events, `touch-action: none`,
 *   44px targets) PLUS four edge-midpoint handles (`data-crop-handle-mid`)
 *   at the same 44px target size with a subtler 14px dot. Corner drag
 *   moves that corner alone (existing); MIDPOINT drag translates the
 *   WHOLE edge — both adjacent corners move together by the same clamped
 *   delta, so a dragged edge never shears and the quad stays a quad
 *   (the warp model remains a homography; no N-point polygon).
 * - Roles TL/TR/BR/BL are fixed — the detected corner order is
 *   normalized ONCE at seed time and never re-run mid-drag (role
 *   swapping under the finger is the classic bug). Edge roles map to
 *   fixed corner-index pairs, also never reordered.
 * - Convexity is enforced on every move via a cross-product-sign check
 *   (TS port of the `validate_quad` idea): positions are clamped to the
 *   image bounds, convexity flips are rejected (the handle stays put).
 * - Keyboard steppers live on the corner handles (`role="slider"`,
 *   arrow keys, Shift for large steps, `role="status"` announcements);
 *   midpoint handles are pointer-only.
 * - Overlay-only feedback during drag (free polygon redraw — no worker
 *   traffic while the pointer is down); the editor fires the debounced
 *   re-warp preview on release / 300ms idle.
 *
 * The QUEUE SURFACE is portaled to `document.body` (full-screen,
 * viewport-true) and is NEVER wrapped in `AnimatePresence` (known
 * codebase footgun: it swallows direct `createPortal()` children). The
 * editor itself renders inline inside that surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Spinner } from '../../components/ui';
import { useContainBox } from '../scanViewport';
import type { ScanCorner } from './scanWorkerClient';

export const CROP_HANDLE_ROLES = ['tl', 'tr', 'br', 'bl'] as const;
export type CropHandleRole = (typeof CROP_HANDLE_ROLES)[number];

/** Edge-midpoint handle roles, in quad order. */
export const CROP_EDGE_ROLES = ['top', 'right', 'bottom', 'left'] as const;
export type CropEdgeRole = (typeof CROP_EDGE_ROLES)[number];

/** Quad with fixed roles: [top-left, top-right, bottom-right, bottom-left]. */
export type CropQuad = [ScanCorner, ScanCorner, ScanCorner, ScanCorner];

const ROLE_LABEL: Record<CropHandleRole, string> = {
  tl: 'top-left',
  tr: 'top-right',
  br: 'bottom-right',
  bl: 'bottom-left',
};

const EDGE_LABEL: Record<CropEdgeRole, string> = {
  top: 'top edge',
  right: 'right edge',
  bottom: 'bottom edge',
  left: 'left edge',
};

/** Edge → the two corner indices it joins (TL/TR/BR/BL order). */
const EDGE_CORNERS: Record<CropEdgeRole, readonly [number, number]> = {
  top: [0, 1],
  right: [1, 2],
  bottom: [2, 3],
  left: [3, 0],
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
   * Object URL of the ORIGINAL full-res capture (adjust-mode photo).
   * Owned by the review queue: minted at queue entry and revoked on
   * advance/discard/exit — never revoked here.
   */
  photoUrl: string;
  /** Full-res capture pixel dims — the quad coordinate space. */
  imageWidth: number;
  imageHeight: number;
  /** Auto-detected corners (unordered); null/absent → inset fallback. */
  initialCorners: ScanCorner[] | null;
  /** Debounced low-res re-warp preview URL (null until first result). */
  cropPreviewUrl: string | null;
  cropPreviewPending: boolean;
  /** Full-res "Looks good" re-warp in flight. */
  applying: boolean;
  /** Fired on page entry, "Apply", and release / 300ms idle (never while dragging). */
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
  // Result-first: the editor opens on the cropped RESULT; "Adjust corners"
  // toggles into the photo + quad editor.
  const [mode, setMode] = useState<'result' | 'adjust'>('result');
  // Seeded once per mount (the page remounts per queue entry, so a lazy
  // initializer is the seed — never re-seeded from props mid-edit).
  const [quad, setQuad] = useState<CropQuad>(() =>
    seedQuad(initialCorners, imageWidth, imageHeight),
  );
  const [dragging, setDragging] = useState(false);
  const quadRef = useRef(quad);
  quadRef.current = quad;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const previewRef = useRef(onPreviewRequest);
  previewRef.current = onPreviewRequest;
  // Latest-wins, duplicate-suppressed preview requests: the mount request
  // and the Apply request may race the debounced one for the same quad.
  const lastPreviewKeyRef = useRef<string | null>(null);
  const hasAutoCorners = initialCorners !== null && initialCorners.length === 4;

  /** Requests the preview for `q` unless it is the one already requested. */
  const requestPreview = useCallback((q: CropQuad) => {
    const key = q.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join('|');
    if (key === lastPreviewKeyRef.current) return;
    lastPreviewKeyRef.current = key;
    previewRef.current(q);
  }, []);

  // Result-first: the page opens ON the cropped result, so request the
  // preview as soon as the page is shown — no edit required. StrictMode's
  // double effect is deduped by the request key.
  useEffect(() => {
    requestPreview(quadRef.current);
  }, [requestPreview]);

  const pointFromClient = (clientX: number, clientY: number): ScanCorner | null => {
    const el = frameRef.current;
    if (el === null || !el.isConnected) return null;
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

  /**
   * Edge-midpoint drag: translates the WHOLE edge. Both adjacent corners
   * move together by one clamped delta (the midpoint follows the pointer;
   * the delta is constrained so the edge can never shear at the image
   * bounds), then convexity is verified exactly like a corner move.
   */
  const moveEdge = (edge: CropEdgeRole, raw: ScanCorner): void => {
    const quad = quadRef.current;
    const [a, b] = EDGE_CORNERS[edge];
    const midX = (quad[a].x + quad[b].x) / 2;
    const midY = (quad[a].y + quad[b].y) / 2;
    const target = {
      x: Math.min(Math.max(raw.x, 0), imageWidth),
      y: Math.min(Math.max(raw.y, 0), imageHeight),
    };
    // Rigid translation: clamp the DELTA (not each corner) so both
    // corners stay in bounds and the edge keeps its exact length/angle.
    const dx = Math.min(
      Math.max(target.x - midX, -Math.min(quad[a].x, quad[b].x)),
      Math.min(imageWidth - quad[a].x, imageWidth - quad[b].x),
    );
    const dy = Math.min(
      Math.max(target.y - midY, -Math.min(quad[a].y, quad[b].y)),
      Math.min(imageHeight - quad[a].y, imageHeight - quad[b].y),
    );
    const next = [...quad] as CropQuad;
    next[a] = { x: next[a].x + dx, y: next[a].y + dy };
    next[b] = { x: next[b].x + dx, y: next[b].y + dy };
    if (!isConvexQuad(next)) return;
    quadRef.current = next;
    setQuad(next);
  };

  /**
   * Shared drag plumbing: window listeners (not pointer capture) keep
   * moves flowing for mouse, touch, and pen alike even when the pointer
   * leaves the 44px target mid-drag. `onMove` closes over its role, so
   * roles never reorder mid-drag.
   */
  const beginDrag =
    (onMove: (pt: ScanCorner) => void): React.PointerEventHandler<HTMLButtonElement> =>
    (e) => {
      e.preventDefault();
      setDragging(true);
      const handleMove = (ev: PointerEvent) => {
        const pt = pointFromClient(ev.clientX, ev.clientY);
        if (pt !== null) onMove(pt);
      };
      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
        // Release: the debounce effect below fires the preview request.
        setDragging(false);
      };
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    };

  const beginCornerDrag = (index: number) => beginDrag((pt) => moveCorner(index, pt));
  const beginEdgeDrag = (edge: CropEdgeRole) => beginDrag((pt) => moveEdge(edge, pt));

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

  // Debounced preview: skipped on mount (the immediate request above is
  // the page-entry one) and while dragging (overlay-only feedback); fires
  // on release / 300ms idle.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (dragging) return;
    const id = window.setTimeout(() => requestPreview(quadRef.current), PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [quad, dragging, requestPreview]);

  /** "Apply": requests a fresh result preview and returns to result mode. */
  const applyAdjustments = () => {
    setMode('result');
    requestPreview(quadRef.current);
  };

  /** "Reset to auto": reseeds the quad from the detected corners. */
  const resetToAuto = () => {
    const reseeded = seedQuad(initialCorners, imageWidth, imageHeight);
    quadRef.current = reseeded;
    setQuad(reseeded);
  };

  const polyPoints = quad.map((p) => `${p.x},${p.y}`).join(' ');
  const holePath = `M0 0H${imageWidth}V${imageHeight}H0Z M${quad[0].x} ${quad[0].y}L${quad[1].x} ${quad[1].y}L${quad[2].x} ${quad[2].y}L${quad[3].x} ${quad[3].y}Z`;

  if (mode === 'result') {
    return (
      <div data-crop-page className="flex min-h-0 flex-1 flex-col">
        {/* The hero IS the cropped result: paper-white, large,
          object-contain, capped by the panel (which is dvh-capped
          upstream) — never the raw photo with a quad. */}
        <div
          data-crop-result
          className="relative flex min-h-[12rem] flex-1 items-center justify-center overflow-hidden rounded-xl border border-paper-300/70 bg-paper-100 p-2 dark:border-ink-800 dark:bg-ink-900"
        >
          {cropPreviewUrl !== null ? (
            <img
              data-crop-result-img
              src={cropPreviewUrl}
              alt="Scanned page result"
              draggable={false}
              className="max-h-[min(100%,72dvh)] max-w-full object-contain"
            />
          ) : !cropPreviewPending ? (
            // Preview failed (best-effort path): show the capture so the
            // page is never a blank panel, plus an honest note.
            <div className="flex max-h-full flex-col items-center gap-2 overflow-hidden px-4 text-center">
              <img
                src={photoUrl}
                alt="Original photo — preview unavailable"
                draggable={false}
                className="max-h-[min(100%,40dvh)] max-w-full object-contain opacity-70"
              />
              <p className="text-xs text-ink-400 dark:text-ink-300">
                Preview unavailable — you can still adjust the corners.
              </p>
            </div>
          ) : null}
          {cropPreviewPending && (
            <div
              data-crop-pending
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center justify-center bg-paper-100/55 dark:bg-ink-900/55"
            >
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-brass-500 border-t-transparent" />
            </div>
          )}
          {cropPreviewPending && <span className="sr-only">Updating preview…</span>}
        </div>
        {/* Simplified decisions: the result is the page — "Looks good"
          commits it as-is; adjusting, keeping the photo, or dropping it
          stay one tap away. */}
        <div className="mt-3 space-y-2">
          <Button
            className="min-h-[48px] w-full"
            onClick={() => onUseCrop(quadRef.current)}
            disabled={applying}
          >
            {applying ? 'Applying crop…' : 'Looks good'}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="min-h-[44px] flex-1"
              onClick={() => setMode('adjust')}
              disabled={applying}
            >
              Adjust corners
            </Button>
            <button
              type="button"
              onClick={onUseOriginal}
              disabled={applying}
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-xl border border-paper-300 px-3 text-xs font-medium text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 disabled:pointer-events-none disabled:opacity-40 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-paper-100"
            >
              Use original
            </button>
            <button
              type="button"
              onClick={onDiscard}
              disabled={applying}
              aria-label="Discard page"
              title="Discard this page"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-paper-300 text-ink-500 transition-colors hover:border-red-400/50 hover:text-red-500 disabled:pointer-events-none disabled:opacity-40 dark:border-ink-700 dark:text-ink-300 dark:hover:text-red-400"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-crop-page data-crop-adjust className="flex min-h-0 flex-1 flex-col">
      <p data-crop-instruction className="mb-2 text-center text-xs text-ink-500 dark:text-ink-300">
        Drag the handles to fit the page — corners move singly, edge dots move the whole edge
      </p>
      {/* Photo LARGE (portrait full-height): a dedicated child owns the
        measured contain box, so the frame measures when adjust mode first
        mounts (the result view is up before this mode ever renders). */}
      <AdjustCanvas
        photoUrl={photoUrl}
        imageWidth={imageWidth}
        imageHeight={imageHeight}
        quad={quad}
        frameRef={frameRef}
        polyPoints={polyPoints}
        holePath={holePath}
        onCornerDrag={beginCornerDrag}
        onEdgeDrag={beginEdgeDrag}
        onHandleKey={onHandleKey}
      />
      {/* Screen-reader mirror of the quad geometry. */}
      <span role="status" className="sr-only">
        {`Crop corners: ${quad
          .map(
            (p, i) => `${ROLE_LABEL[CROP_HANDLE_ROLES[i]]} ${Math.round(p.x)}, ${Math.round(p.y)}`,
          )
          .join('; ')}`}
      </span>
      {/* Adjust-mode decisions: Apply returns to the result view (fresh
        preview requested); Reset reseeds from the auto corners. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button className="min-h-[44px] flex-1" onClick={applyAdjustments} disabled={applying}>
          {applying ? 'Applying crop…' : 'Apply'}
        </Button>
        <Button
          variant="ghost"
          className="min-h-[44px]"
          onClick={resetToAuto}
          disabled={applying || !hasAutoCorners}
        >
          Reset to auto
        </Button>
      </div>
    </div>
  );
}

/**
 * Adjust-mode canvas: the measured contain frame (original photo + quad
 * overlay + 44px drag handles — 4 corners plus 4 edge midpoints). Kept
 * as its own component so the `useContainBox` measurement happens while
 * the frame is mounted — the result view renders before adjust mode ever
 * appears, so an inline measurement would miss the frame's first mount
 * and fall back to raw CSS sizing (overflowing the queue on wide screens).
 */
function AdjustCanvas({
  photoUrl,
  imageWidth,
  imageHeight,
  quad,
  frameRef,
  polyPoints,
  holePath,
  onCornerDrag,
  onEdgeDrag,
  onHandleKey,
}: {
  photoUrl: string;
  imageWidth: number;
  imageHeight: number;
  quad: CropQuad;
  frameRef: React.RefObject<HTMLDivElement | null>;
  polyPoints: string;
  holePath: string;
  onCornerDrag: (index: number) => React.PointerEventHandler<HTMLButtonElement>;
  onEdgeDrag: (edge: CropEdgeRole) => React.PointerEventHandler<HTMLButtonElement>;
  onHandleKey: (index: number) => React.KeyboardEventHandler<HTMLButtonElement>;
}) {
  // Exact painted-frame mapping (same helper as the viewfinder): the
  // inner frame renders the contain rect, so client↔image conversion is
  // exact with no letterbox math.
  const viewport = useContainBox<HTMLDivElement>(imageWidth / imageHeight);
  return (
    <div ref={viewport.ref} className="flex min-h-[12rem] flex-1 items-center justify-center">
      {/* Draggable handles (buttons so they are keyboard focusable).
        Pointer model (deliberately single-path): the drag plumbing above
        is full pointer-events (down/move/up) — mouse, touch, AND pen all
        flow through beginDrag, including synthetic PointerEvents from
        tests/E2E (no hardware pointer id, isPrimary false). There is no
        separate mouse/pen fallback branch to drift apart from the real
        path (2026-10-03: a well-meaning "pen responds" branch broke E2E
        drag while unit tests stayed green). */}
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
          alt="Original photo — drag the corner handles to the page edges, edge dots move a whole edge"
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
              onPointerDown={onCornerDrag(i)}
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
        {/* Edge-midpoint handles: same 44px target, subtler 14px dot —
          dragging one translates the WHOLE edge (both adjacent corners
          move together). Pointer-only: keyboard steppers stay on the
          corners. */}
        {CROP_EDGE_ROLES.map((edge) => {
          const [a, b] = EDGE_CORNERS[edge];
          const mx = (quad[a].x + quad[b].x) / 2;
          const my = (quad[a].y + quad[b].y) / 2;
          return (
            <button
              key={`mid-${edge}`}
              type="button"
              data-crop-handle-mid={edge}
              aria-label={`Move ${EDGE_LABEL[edge]}`}
              title={`Move the ${EDGE_LABEL[edge]} (both corners together)`}
              onPointerDown={onEdgeDrag(edge)}
              className="absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-300"
              style={{
                left: `${(mx / imageWidth) * 100}%`,
                top: `${(my / imageHeight) * 100}%`,
              }}
            >
              <span
                aria-hidden
                className="h-3.5 w-3.5 rounded-full border-2 border-brass-500/90 bg-paper-50 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Page view model handed to the queue: only ready entries carry meta. */
export interface ScanReviewEntry {
  /** Queue entry id — keys the page so each entry reseeds its quad. */
  id: number;
  /** False while the background detect job is still preparing metadata. */
  ready: boolean;
  /** Object URL of the original capture (adjust-mode photo). */
  photoUrl: string;
  /** Capture pixel dims (the quad coordinate space) — ready only. */
  imageWidth: number;
  imageHeight: number;
  /** Auto-detected corners (unordered); null → inset fallback. */
  initialCorners: ScanCorner[] | null;
}

export interface ScanReviewQueueProps {
  /** 1-based position in the queue snapshot ("Page i of N"). */
  pageIndex: number;
  /** Snapshot size ("Page i of N") — stable while the queue is open. */
  pageCount: number;
  /** Page under review; null only on the completion screen. */
  entry: ScanReviewEntry | null;
  /** True once every queued page was resolved: shows the build end screen. */
  complete: boolean;
  cropPreviewUrl: string | null;
  cropPreviewPending: boolean;
  applying: boolean;
  onPreviewRequest: (quad: CropQuad) => void;
  onUseCrop: (quad: CropQuad) => void;
  onUseOriginal: () => void;
  onDiscard: () => void;
  /** Exits the queue (unreviewed entries commit as originals). */
  onBack: () => void;
  /** Review end "Build PDF": the parent wiring leaves camera mode. */
  onBuildNow: () => void;
}

/**
 * Full-screen review queue surface: one page at a time, result-first,
 * "Page i of N" header + slim per-page progress. Portaled to
 * `document.body` so `fixed` is viewport-true — NEVER wrapped in
 * `AnimatePresence` (it swallows direct portal children). 44px targets
 * throughout; `dvh`-capped.
 */
export function ScanReviewQueue({
  pageIndex,
  pageCount,
  entry,
  complete,
  cropPreviewUrl,
  cropPreviewPending,
  applying,
  onPreviewRequest,
  onUseCrop,
  onUseOriginal,
  onDiscard,
  onBack,
  onBuildNow,
}: ScanReviewQueueProps) {
  const reviewed = complete ? pageCount : Math.max(0, pageIndex - 1);
  const progressPercent = pageCount > 0 ? Math.min(100, (reviewed / pageCount) * 100) : 0;
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
      {/* Slim per-page progress ("3 of 12 reviewed" for assistive tech). */}
      <div
        data-review-progress
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={pageCount}
        aria-valuenow={reviewed}
        aria-label={`${reviewed} of ${pageCount} reviewed`}
        className="h-1 w-full shrink-0 bg-paper-200 dark:bg-ink-800"
      >
        <div className="h-full bg-brass-400" style={{ width: `${progressPercent}%` }} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
        {complete ? (
          <ReviewComplete onBuildNow={onBuildNow} onBack={onBack} />
        ) : entry === null || !entry.ready ? (
          // Background detect still preparing this page (capture order):
          // the page renders as soon as its metadata lands.
          <div data-scan-preparing className="flex min-h-0 flex-1 items-center justify-center">
            <Spinner label="Preparing this page…" />
          </div>
        ) : (
          <CropEditor
            key={entry.id}
            photoUrl={entry.photoUrl}
            imageWidth={entry.imageWidth}
            imageHeight={entry.imageHeight}
            initialCorners={entry.initialCorners}
            cropPreviewUrl={cropPreviewUrl}
            cropPreviewPending={cropPreviewPending}
            applying={applying}
            onPreviewRequest={onPreviewRequest}
            onUseCrop={onUseCrop}
            onUseOriginal={onUseOriginal}
            onDiscard={onDiscard}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Review end screen: every queued page resolved → build the PDF here. */
function ReviewComplete({ onBuildNow, onBack }: { onBuildNow: () => void; onBack: () => void }) {
  return (
    <div
      data-review-complete
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-4 text-center"
    >
      <span
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-full bg-forest-500/15 text-forest-600 dark:text-forest-300"
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      <div>
        <p className="font-display text-lg font-semibold text-ink-900 dark:text-paper-100">
          All pages ready
        </p>
        <p className="mt-1 text-xs text-ink-400 dark:text-ink-300">
          Build your PDF now, or go back and add more pages.
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button className="min-h-[48px] w-full" onClick={onBuildNow}>
          Build PDF
        </Button>
        <Button variant="ghost" className="min-h-[44px] w-full" onClick={onBack}>
          Back to camera
        </Button>
      </div>
    </div>
  );
}
