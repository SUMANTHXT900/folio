import { useEffect, useState, useMemo, memo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Reorder, motion, useDragControls, type DragControls } from 'framer-motion';
import {
  ToolHeading,
  DropZone,
  FileChip,
  Button,
  Spinner,
  Card,
  Progress,
  ErrorBlock,
} from '../components/ui';
import ContinueCard from '../components/ContinueCard';
import { smartOutputName } from '../components/downloadNaming';
import { usePdfFiles } from '../hooks/usePdfFiles';
import { usePageThumbs } from '../hooks/usePageThumbs';
import { runStudioOperation, type StudioOutput, type StudioJob } from '../services/folio';
import { usePendingTransfer } from './usePendingTransfer';
import { cancelledError } from './studioJob';

const PAGE_LIMIT = 24;

const RearrangeRow = memo(function RearrangeRow({
  pageIdx,
  pos,
  thumb,
  onMove,
  onPreview,
  isFirst,
  isLast,
  dragControls,
}: {
  pageIdx: number;
  pos: number;
  thumb: string;
  onMove: (pos: number, dir: -1 | 1) => void;
  onPreview: (pos: number) => void;
  isFirst: boolean;
  isLast: boolean;
  dragControls: DragControls;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-800/60 px-3 py-2">
      {/* Drag handle — the ONLY touch point that starts a drag. The rest of the
          row keeps the page's vertical scroll (see DragRow's pan-y).
          Keyboard: a real button (Tab-reachable) — arrows nudge one step,
          Enter/Space moves later. Pointer drag is unchanged. */}
      <button
        type="button"
        onPointerDown={(e) => dragControls.start(e)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            onMove(pos, -1);
          } else if (
            e.key === 'ArrowDown' ||
            e.key === 'ArrowRight' ||
            e.key === 'Enter' ||
            e.key === ' '
          ) {
            e.preventDefault();
            onMove(pos, 1);
          }
        }}
        className="flex w-11 h-11 min-w-[44px] min-h-[44px] shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-ink-400 dark:text-ink-300 hover:text-brass-500 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/60 focus-visible:ring-offset-1 focus-visible:ring-offset-paper-50 dark:focus-visible:ring-offset-ink-800"
        aria-label={`Reorder Page ${pageIdx + 1}: arrow keys move, Enter moves later`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="9" cy="6" r="1.6" />
          <circle cx="15" cy="6" r="1.6" />
          <circle cx="9" cy="12" r="1.6" />
          <circle cx="15" cy="12" r="1.6" />
          <circle cx="9" cy="18" r="1.6" />
          <circle cx="15" cy="18" r="1.6" />
        </svg>
      </button>
      <span className="w-6 text-center text-xs font-mono text-ink-400 dark:text-ink-300">
        {pos + 1}
      </span>
      <button onClick={() => onPreview(pos)} className="flex-1 flex items-center gap-3 text-left">
        {thumb ? (
          <img
            src={thumb}
            alt={`Page ${pageIdx + 1}`}
            loading="lazy"
            decoding="async"
            className="w-10 h-14 object-cover rounded border border-paper-300 dark:border-ink-700"
          />
        ) : (
          <div className="w-10 h-14 rounded bg-paper-200 dark:bg-ink-700 animate-pulse" />
        )}
        <span className="text-sm text-ink-700 dark:text-paper-100">Page {pageIdx + 1}</span>
      </button>
      <div className="flex flex-col">
        <button
          onClick={() => onMove(pos, -1)}
          disabled={isFirst}
          className="px-3 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-ink-400 dark:text-ink-300 hover:text-brass-500 disabled:opacity-30 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/60"
          aria-label="Move up"
          title={`Move Page ${pageIdx + 1} earlier`}
        >
          ↑
        </button>
        <button
          onClick={() => onMove(pos, 1)}
          disabled={isLast}
          className="px-3 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-ink-400 dark:text-ink-300 hover:text-brass-500 disabled:opacity-30 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/60"
          aria-label="Move down"
          title={`Move Page ${pageIdx + 1} later`}
        >
          ↓
        </button>
      </div>
    </div>
  );
});

/* One reorderable row: drag starts ONLY from the handle (dragListener={false}).
   The item keeps `touch-action: pan-y` so vertical page scroll works on touch.
   Memoized: stable per-row props (primitives + stable callbacks) keep drags
   from re-rendering every row. */
const DragRow = memo(function DragRow({
  pageIdx,
  pos,
  thumb,
  onMove,
  onPreview,
  isFirst,
  isLast,
}: {
  pageIdx: number;
  pos: number;
  thumb: string;
  onMove: (pos: number, dir: -1 | 1) => void;
  onPreview: (pos: number) => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={pageIdx}
      dragListener={false}
      dragControls={controls}
      className="list-none"
      style={{ touchAction: 'pan-y' }}
      whileDrag={{ scale: 1.015, boxShadow: '0 12px 28px -12px rgba(23,19,14,0.25)' }}
    >
      <RearrangeRow
        pageIdx={pageIdx}
        pos={pos}
        thumb={thumb}
        onMove={onMove}
        onPreview={onPreview}
        isFirst={isFirst}
        isLast={isLast}
        dragControls={controls}
      />
    </Reorder.Item>
  );
});

export default function RearrangeTool() {
  const {
    files,
    setFiles,
    addFiles,
    remove,
    error: filesError,
    busy,
    setBusy,
    setError,
  } = usePdfFiles();
  const file = files[0] ?? null;
  const { thumbs, load, fillAll, loading, progress, renderPreview } = usePageThumbs();
  const [order, setOrder] = useState<number[]>([]);
  const [result, setResult] = useState<{
    outputs: StudioOutput[];
    sourceName: string;
    /** Engine `StudioResult.durationMs` — display-only (D4), owned by the card's summary line. */
    durationMs: number;
  } | null>(null);
  // Shared pending-transfer intake (claim + gen-guarded back-out release).
  const { claimedRef, ranRef, continuedFrom } = usePendingTransfer(setFiles, 'single');
  const [opError, setOpError] = useState<unknown>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  // Preview-dialog focus discipline (AUD-6): the Close button takes focus
  // on open, Escape closes, and focus returns to the opener on close.
  const viewerCloseRef = useRef<HTMLButtonElement>(null);
  const viewerPrevFocusRef = useRef<Element | null>(null);
  const isViewerOpen = viewer !== null;
  useEffect(() => {
    if (!isViewerOpen) return;
    viewerPrevFocusRef.current = document.activeElement;
    viewerCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewer(null);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const prev = viewerPrevFocusRef.current as HTMLElement | null;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [isViewerOpen]);
  const [hiRes, setHiRes] = useState<Record<number, string>>({});
  const [fraction, setFraction] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const jobRef = useRef<StudioJob | null>(null);

  // render the inspected page at full res (cached per page, revoked on file change/unmount).
  // `order`/`hiRes` ride refs so rapid reorders while the viewer is open
  // never restart the in-flight preview render.
  const orderRef = useRef(order);
  orderRef.current = order;
  const hiResRef = useRef(hiRes);
  hiResRef.current = hiRes;
  useEffect(() => {
    if (viewer === null || !file) return;
    const pageIdx = orderRef.current[viewer];
    if (pageIdx === undefined) return;
    const pageNum = pageIdx + 1;
    if (hiResRef.current[pageNum]) return;
    const job = renderPreview(file.id, pageNum);
    let alive = true;
    (async () => {
      try {
        const url = await job.done;
        if (alive) setHiRes((prev) => ({ ...prev, [pageNum]: url }));
      } catch {
        /* keep thumb fallback */
      }
    })();
    return () => {
      alive = false;
      job.cancel();
    };
  }, [viewer, file, renderPreview]);
  // Full-res preview URLs are service-owned borrows (see `studioPreview`:
  // never revoke the result). Dropping the cache entry is enough — the
  // service purges its keys on close/evict, so no caller-side revoke here.
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setResult(null);
    setOpError(null);
    setShowAll(false);
    setHiRes({});
    if (!file) {
      setOrder([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const t = await load(file.id, file.pageCount, PAGE_LIMIT);
        if (!cancelled) setOrder(Array.from({ length: t.length }, (_, i) => i));
      } catch (e) {
        if (!cancelled) {
          const code = e instanceof Error ? (e as { code?: string }).code : undefined;
          setError(
            e instanceof Error
              ? code && code !== 'CANCELLED'
                ? `${e.message} (${code})`
                : e.message
              : 'Could not render page previews.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, load]);
  const visibleOrder = useMemo(() => {
    if (order.length <= 30 || showAll) return order;
    return order.slice(0, PAGE_LIMIT);
  }, [order, showAll]);
  const hiddenCount = order.length - visibleOrder.length;
  // No-op honesty: an identity order would "succeed" without changing a
  // byte — keep Save disabled with the reason inline instead of
  // celebrating a Done card for doing nothing.
  const isIdentity = order.length > 0 && order.every((v, i) => v === i);

  const handleRearrange = useCallback(async () => {
    if (!file) return;
    ranRef.current = true;
    setBusy(true);
    setError(null);
    setOpError(null);
    setResult(null);
    setFraction(null);
    setStage(null);
    try {
      const job = runStudioOperation(
        'pdf.reorder',
        [file.id],
        { order: order.map((i) => i + 1) },
        {
          onProgress: (p) => {
            setFraction(p.fraction);
            setStage(p.label);
          },
        },
      );
      jobRef.current = job;
      const out = await job.done;
      jobRef.current = null;
      const first = out.outputs[0];
      if (first === undefined) throw new Error('Rearrange produced no output.');
      // Existing naming, unchanged: `<base>-rearranged.pdf`. It doubles as
      // the handoff `sourceName`, and labels the single output so the
      // ContinueCard download branch and the handed-off record name the file
      // exactly as the old DownloadCard did (Images parity).
      const sourceName = smartOutputName('rearrange', [file.name]);
      setResult({
        outputs: [{ ...first, name: sourceName }],
        sourceName,
        durationMs: out.durationMs,
      });
    } catch (e) {
      jobRef.current = null;
      const code = (e as { code?: string }).code;
      if (code === 'CANCELLED') {
        setOpError(cancelledError('rearrange'));
      } else {
        setOpError(e);
      }
    } finally {
      setBusy(false);
      setFraction(null);
      setStage(null);
    }
  }, [file, order, setBusy, setError]);

  const onCancel = async () => {
    try {
      await jobRef.current?.cancel();
    } catch {
      // The job settles the UI via handleRearrange's catch/finally.
    }
  };

  const move = useCallback((idx: number, dir: -1 | 1) => {
    setOrder((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }, []);

  // Stable per-row preview callback: DragRow stays memoized because it
  // receives this reference (plus primitives), never fresh closures.
  const handlePreview = useCallback((pos: number) => {
    setViewer(pos);
  }, []);

  const handleBackToEdit = useCallback(() => {
    setResult(null);
  }, []);

  return (
    <div className="py-6">
      <ToolHeading
        icon={<RearrangeIcon />}
        name="Rearrange"
        desc="Drag the handle to reorder, or use the arrows — click a page to preview it"
      />

      {!file && (
        <DropZone
          accept="application/pdf"
          multiple={false}
          onFiles={(f) => addFiles(f)}
          title="Drop a PDF to rearrange"
          cta="Select PDF"
        />
      )}

      {file && (
        <div className="space-y-5">
          {continuedFrom && (
            <p className="text-xs text-brass-600 dark:text-brass-300 bg-brass-400/[0.07] rounded-xl px-4 py-2.5 border border-brass-500/25">
              Continued from{' '}
              {continuedFrom.producedBy.charAt(0).toUpperCase() + continuedFrom.producedBy.slice(1)}{' '}
              — {continuedFrom.sourceName} is loaded below by reference (not re-uploaded).
            </p>
          )}
          <FileChip
            name={file.name}
            size={file.sizeBytes}
            onRemove={() => {
              claimedRef.current = claimedRef.current.filter((d) => d.id !== file.id);
              remove(file.id);
              setResult(null);
              setOpError(null);
            }}
          />

          {loading && (
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center gap-2 text-sm text-ink-400 dark:text-ink-300">
                <Spinner /> Rendering page previews…
              </div>
              {progress && progress.total > 0 && progress.done < progress.total && (
                <div className="w-full max-w-xs">
                  <Progress
                    value={(progress.done / progress.total) * 100}
                    label={`${progress.done} of ${progress.total} pages`}
                  />
                </div>
              )}
            </div>
          )}

          {!loading && order.length > 0 && (
            <Card>
              <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-3">
                Drag the handle to reorder, or use the arrows — click a page to preview
              </p>
              <Reorder.Group axis="y" values={order} onReorder={setOrder} className="space-y-2">
                {visibleOrder.map((pageIdx, i) => (
                  <DragRow
                    key={pageIdx}
                    pageIdx={pageIdx}
                    pos={i}
                    thumb={thumbs[pageIdx]}
                    onMove={move}
                    onPreview={handlePreview}
                    isFirst={i === 0}
                    isLast={i === order.length - 1}
                  />
                ))}
              </Reorder.Group>
              {hiddenCount > 0 && (
                <button
                  onClick={() => {
                    setShowAll(true);
                    void fillAll();
                  }}
                  className="mt-3 w-full min-h-[44px] rounded-xl border-2 border-dashed border-paper-300 dark:border-ink-700 py-3 text-sm text-ink-500 hover:border-brass-400 hover:text-brass-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/60"
                >
                  {progress && progress.done < progress.total
                    ? `Load & show ${Math.min(hiddenCount, 48)} more of ${hiddenCount} (${progress.done}/${progress.total} ready)`
                    : thumbs.filter(Boolean).length < order.length
                      ? `Load & show ${Math.min(hiddenCount, 48)} more of ${hiddenCount}`
                      : `Show ${hiddenCount} more pages`}
                </button>
              )}
              {hiddenCount === 0 && order.length > 30 && showAll && (
                <button
                  onClick={() => setShowAll(false)}
                  className="mt-3 min-h-[44px] px-3 inline-flex items-center text-xs text-ink-400 dark:text-ink-300 hover:text-ink-700 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/60"
                >
                  Show less
                </button>
              )}
            </Card>
          )}

          {!result && order.length > 0 && (
            <div className="flex items-center gap-3">
              <Button onClick={handleRearrange} disabled={busy || isIdentity} className="w-full">
                {busy ? <Spinner /> : 'Save rearranged PDF'}
              </Button>
              {busy && (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </div>
          )}
          {!result && !busy && isIdentity && (
            <p className="text-xs text-ink-400 dark:text-ink-300">
              Pages are in their original order — drag the handle or use the arrows to reorder
              before saving.
            </p>
          )}
          {busy && fraction !== null && (
            <div className="w-full max-w-xs">
              <Progress value={fraction * 100} label={stage ?? 'Working…'} />
            </div>
          )}

          {result && (
            <ContinueCard
              outputs={result.outputs}
              sourceName={result.sourceName}
              producedBy="rearrange"
              onBackToEdit={handleBackToEdit}
              durationMs={result.durationMs}
            />
          )}
        </div>
      )}

      {filesError && (
        <p role="alert" className="mt-4 text-sm text-red-500">
          {filesError}
        </p>
      )}
      {opError !== null && <ErrorBlock error={opError} />}

      <>
        {viewer !== null &&
          // Portaled to document.body: the Card above carries
          // `backdrop-filter` (via the shared Card's backdrop-blur), which per
          // spec becomes the containing block for in-tree `fixed` descendants
          // — the backdrop then spans the tall card and the dialog centers
          // off-screen (F-19, cf. PageGrid). The portal escapes every
          // ancestor, so `fixed inset-0` is always the real viewport. `dvh`
          // caps keep the mobile URL bar from cropping.
          // NOTE: no AnimatePresence here — this framer-motion version
          // swallows direct createPortal() children (dialog never mounts).
          // Enter is a 180ms fade+scale via plain motion initial/animate
          // (transform/opacity only); close unmounts instantly.
          createPortal(
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
              onClick={() => setViewer(null)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="max-w-3xl w-full max-h-[92dvh] flex flex-col overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={`Preview Page ${order[viewer] + 1}`}
              >
                <div className="flex items-center justify-between mb-2 text-paper-100 shrink-0">
                  <span className="font-display text-lg">Page {order[viewer] + 1}</span>
                  <button
                    ref={viewerCloseRef}
                    onClick={() => setViewer(null)}
                    className="rounded-full bg-white/10 px-4 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-sm hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  >
                    Close
                  </button>
                </div>
                {(() => {
                  const pageNum = order[viewer] + 1;
                  const hi = hiRes[pageNum];
                  const fallback = thumbs[order[viewer]];
                  return hi ? (
                    <img
                      src={hi}
                      alt={`Page ${pageNum} (full resolution)`}
                      className="w-full rounded-xl shadow-2xl bg-white object-contain max-h-[78dvh]"
                    />
                  ) : (
                    <>
                      {fallback && (
                        <img
                          src={fallback}
                          alt={`Page ${pageNum}`}
                          className="w-full rounded-xl shadow-2xl bg-white object-contain max-h-[78dvh] opacity-80"
                        />
                      )}
                      {!fallback && <div className="h-64 rounded-xl bg-white/20 animate-pulse" />}
                      <p className="mt-2 text-center text-xs text-paper-100/80">
                        Rendering full-resolution view…
                      </p>
                    </>
                  );
                })()}
              </motion.div>
            </motion.div>,
            document.body,
          )}
      </>
    </div>
  );
}
function RearrangeIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8l6-5-6 5zm0 0 6 5M21 16l-6 5 6-5zm0 0-6-5" />
    </svg>
  );
}
