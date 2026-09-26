/**
 * Page Manager list for Images → PDF.
 *
 * Same UI/UX as the Rearrange tool: a vertical row list (position
 * number, thumbnail button, name) with handle-only drag (framer-motion
 * `Reorder`, touch keeps `pan-y` page scroll), guaranteed ↑/↓ move
 * buttons, click-to-preview modal, rotate + remove actions.
 *
 * Full reorder arrives as an id list from `Reorder.Group` and commits
 * through `reorderPages` (pure, tested in `imagePages.test.ts`);
 * per-card move buttons stay the E2E-asserted guaranteed path.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Reorder, useDragControls, type DragControls } from 'framer-motion';
import { formatBytes } from '../components/ui';
import type { ImagePage } from './imagePages';

interface PageGridProps {
  pages: ImagePage[];
  onMove: (id: string, dir: -1 | 1) => void;
  onReorder: (ids: string[]) => void;
  onRemove: (id: string) => void;
  onRotate: (id: string) => void;
}

const controlBtn =
  'flex h-9 min-w-9 items-center justify-center rounded-lg px-1.5 text-sm text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 disabled:opacity-25 dark:text-ink-300 dark:hover:bg-ink-700 dark:hover:text-paper-100';

const GripIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="9" cy="6" r="1.6" />
    <circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" />
    <circle cx="15" cy="18" r="1.6" />
  </svg>
);

/**
 * Self-healing preview source for one page.
 *
 * `loading="lazy"` used to gate blob-URL previews — a pointless trade
 * (local URLs, no network) that could leave previews unloaded in some
 * mobile/in-app browsers. Loading is eager now, and if the image still
 * fails to decode (e.g. an Android tab restored from the background
 * whose blob storage was reclaimed), the hook re-materializes the
 * object URL from the page's retained File handle once; a second
 * failure reports `failed` so callers render an explicit placeholder —
 * never a silent blank (real-phone report: "light background, not the image").
 */
function usePreviewSrc(page: ImagePage): {
  src: string;
  failed: boolean;
  onError: () => void;
} {
  const [src, setSrc] = useState(page.previewUrl);
  const [failed, setFailed] = useState(page.previewUrl === '');
  const [retried, setRetried] = useState(false);
  const recoveredUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (recoveredUrlRef.current !== null) {
        URL.revokeObjectURL(recoveredUrlRef.current);
        recoveredUrlRef.current = null;
      }
    };
  }, []);

  const onError = () => {
    if (retried) {
      setFailed(true);
      return;
    }
    setRetried(true);
    try {
      const url = URL.createObjectURL(page.file);
      recoveredUrlRef.current = url;
      setSrc(url);
    } catch {
      setFailed(true);
    }
  };

  return { src, failed, onError };
}

function PageThumb({ page, position }: { page: ImagePage; position: number }) {
  const { src, failed, onError } = usePreviewSrc(page);

  if (failed) {
    return (
      <span
        aria-label={`Preview unavailable for ${page.name}`}
        className="flex h-16 w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded border border-dashed border-paper-300 bg-paper-200/60 text-ink-400 dark:border-ink-700 dark:bg-ink-900/60 dark:text-ink-300"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M7 10l5 5 5-5M12 15V3" />
        </svg>
        <span className="text-[9px] leading-none">N/A</span>
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={`Page ${position + 1} preview: ${page.name}`}
      decoding="async"
      draggable={false}
      onError={onError}
      style={{ transform: `rotate(${page.rotationDeg}deg)` }}
      className="h-16 w-12 shrink-0 rounded border border-paper-300 object-cover dark:border-ink-700"
    />
  );
}

const PageRow = memo(function PageRow({
  page,
  position,
  isFirst,
  isLast,
  onMove,
  onRemove,
  onRotate,
  onPreview,
  dragControls,
}: {
  page: ImagePage;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onRotate: () => void;
  onPreview: () => void;
  dragControls: DragControls;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-800/60 px-2.5 py-2 sm:gap-3 sm:px-3">
      {/* Drag handle — the ONLY touch point that starts a drag. The rest
          of the row keeps the page's vertical scroll (pan-y). */}
      <span
        onPointerDown={(e) => dragControls.start(e)}
        className="flex h-8 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-ink-400 hover:text-brass-500 active:cursor-grabbing sm:w-8"
        aria-label={`Drag ${page.name} to reorder`}
        role="button"
      >
        {GripIcon}
      </span>
      <span className="w-5 shrink-0 text-center text-xs font-mono text-ink-400 tabular-nums sm:w-6">
        {position + 1}
      </span>
      <button
        onClick={onPreview}
        aria-label={`Preview ${page.name}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left sm:gap-3"
      >
        <PageThumb page={page} position={position} />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-sm text-ink-700 dark:text-paper-100"
            title={`${page.name} · ${formatBytes(page.size)}`}
          >
            {page.name}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-ink-400 dark:text-ink-300">
            {formatBytes(page.size)}
            {page.source === 'camera' ? ' · camera' : ' · file'}
            {page.rotationDeg !== 0 ? ` · ${page.rotationDeg}°` : ''}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 flex-col">
        <button
          onClick={() => onMove(-1)}
          disabled={isFirst}
          className="px-3 py-1 text-ink-400 hover:text-brass-500 disabled:opacity-30"
          aria-label={`Move ${page.name} earlier`}
        >
          ↑
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={isLast}
          className="px-3 py-1 text-ink-400 hover:text-brass-500 disabled:opacity-30"
          aria-label={`Move ${page.name} later`}
        >
          ↓
        </button>
      </div>
      <div className="flex shrink-0">
        <button
          onClick={onRotate}
          className={controlBtn}
          aria-label={`Rotate ${page.name} 90 degrees clockwise`}
          title="Rotate 90° clockwise"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.75 1 6.4 2.6L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
        <button
          onClick={onRemove}
          className={controlBtn + ' hover:!bg-red-50 hover:!text-red-500 dark:hover:!bg-red-950/40'}
          aria-label={`Remove ${page.name}`}
          title="Remove page"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
});

/* One reorderable row: drag starts ONLY from the handle
   (dragListener={false}). The item keeps `touch-action: pan-y` so
   vertical page scroll works on touch. */
function DragRow({
  page,
  position,
  isFirst,
  isLast,
  onMove,
  onRemove,
  onRotate,
  onPreview,
}: {
  page: ImagePage;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onRotate: () => void;
  onPreview: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={page.id}
      dragListener={false}
      dragControls={controls}
      className="list-none"
      style={{ touchAction: 'pan-y' }}
      aria-label={`Page ${position + 1}: ${page.name}`}
    >
      <PageRow
        page={page}
        position={position}
        isFirst={isFirst}
        isLast={isLast}
        onMove={onMove}
        onRemove={onRemove}
        onRotate={onRotate}
        onPreview={onPreview}
        dragControls={controls}
      />
    </Reorder.Item>
  );
}

export function PageGrid({ pages, onMove, onReorder, onRemove, onRotate }: PageGridProps) {
  const ids = useMemo(() => pages.map((p) => p.id), [pages]);
  const [viewer, setViewer] = useState<number | null>(null);
  const viewing = viewer === null ? null : (pages[viewer] ?? null);

  return (
    <>
      <Reorder.Group
        axis="y"
        values={ids}
        onReorder={onReorder}
        className="list-none space-y-2"
        aria-label="Pages in PDF order"
      >
        {pages.map((page, i) => (
          <DragRow
            key={page.id}
            page={page}
            position={i}
            isFirst={i === 0}
            isLast={i === pages.length - 1}
            onMove={(dir) => onMove(page.id, dir)}
            onRemove={() => onRemove(page.id)}
            onRotate={() => onRotate(page.id)}
            onPreview={() => setViewer(i)}
          />
        ))}
      </Reorder.Group>

      {viewing !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setViewer(null)}
        >
          <div
            className="max-w-3xl w-full max-h-[92vh] flex flex-col overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={`Preview page ${(viewer ?? 0) + 1}: ${viewing.name}`}
          >
            <div className="flex items-center justify-between mb-2 text-paper-100 shrink-0">
              <span className="font-display text-lg">Page {(viewer ?? 0) + 1}</span>
              <button
                onClick={() => setViewer(null)}
                className="rounded-full bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
              >
                Close
              </button>
            </div>
            <PreviewFull page={viewing} position={viewer ?? 0} />
          </div>
        </div>
      )}
    </>
  );
}

/** Full-size modal preview with the same self-healing source as rows. */
function PreviewFull({ page, position }: { page: ImagePage; position: number }) {
  const { src, failed, onError } = usePreviewSrc(page);
  if (failed) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl bg-white/10 text-center text-paper-100">
        <span className="font-display text-base">Preview unavailable</span>
        <span className="max-w-xs truncate px-4 text-xs opacity-70">{page.name}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`Page ${position + 1} full preview: ${page.name}`}
      onError={onError}
      style={{ transform: `rotate(${page.rotationDeg}deg)` }}
      className="w-full rounded-xl shadow-2xl bg-white object-contain max-h-[82vh]"
    />
  );
}
