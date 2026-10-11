import { useEffect, useState, useMemo, memo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
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
import { smartSplitPartName } from '../components/downloadNaming';
import { usePdfFiles } from '../hooks/usePdfFiles';
import { usePageThumbs } from '../hooks/usePageThumbs';
import {
  runStudioOperation,
  consumePendingTransfer,
  getStudioBytes,
  closeStudioDoc,
  thumbGridBox,
  type StudioDoc,
  type StudioOutput,
  type StudioJob,
} from '../services/folio';

const PAGE_LIMIT = 24;

const ThumbTile = memo(function ThumbTile({
  src,
  index,
  kept,
  onToggle,
  onPreview,
}: {
  src: string;
  index: number;
  kept: boolean;
  onToggle: (i: number) => void;
  onPreview: (i: number) => void;
}) {
  // Gesture split (RearrangeTool parity): the thumbnail opens the large
  // page preview; only the explicit keep/remove pill toggles selection.
  // This keeps preview clicks from ever disturbing the kept count.
  return (
    <div
      className={
        'relative rounded-lg overflow-hidden border-2 transition-[border-color,opacity] ' +
        (kept ? 'border-transparent' : 'border-red-400/70 opacity-40')
      }
    >
      <button
        onClick={() => onPreview(index)}
        aria-label={`Preview Page ${index + 1}`}
        className="block w-full cursor-zoom-in"
      >
        {src ? (
          <img
            src={src}
            alt={`Page ${index + 1}`}
            loading="eager"
            decoding="async"
            className="w-full aspect-[3/4] object-cover bg-white hover:opacity-90 transition-opacity"
          />
        ) : (
          <div className="w-full aspect-[3/4] bg-paper-200 dark:bg-ink-700 animate-pulse" />
        )}
      </button>
      <button
        onClick={() => onToggle(index)}
        aria-label={`${kept ? 'Remove' : 'Keep'} Page ${index + 1}`}
        className="absolute bottom-0 left-0 right-0 py-2 flex items-center justify-center bg-black/60 text-paper-100 text-xs text-center hover:bg-black/75 transition-colors"
      >
        {kept ? `Page ${index + 1}` : 'removed'}
      </button>
    </div>
  );
});

function parseRanges(text: string): [number, number][] {
  return text
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p): [number, number] => {
      if (p.includes('-')) {
        const [a, b] = p.split('-').map((x) => parseInt(x, 10));
        return [a, b];
      }
      const n = parseInt(p, 10);
      return [n, n];
    })
    .filter(([a, b]) => !isNaN(a) && !isNaN(b));
}

export default function SplitTool() {
  const {
    files,
    addFiles,
    remove,
    setFiles,
    error: filesError,
    busy,
    setBusy,
    setError,
  } = usePdfFiles();
  const file = files[0] ?? null;
  const { thumbs, load, fillAll, loading, progress, renderPreview } = usePageThumbs();
  const [count, setCount] = useState(0);
  const [keep, setKeep] = useState<boolean[]>([]);
  const [mode, setMode] = useState<'pick' | 'ranges'>('pick');
  const [ranges, setRanges] = useState('');
  const [result, setResult] = useState<{
    outputs: StudioOutput[];
    sourceName: string;
    /** Engine `StudioResult.durationMs` — display-only (D4), owned by the card's summary line. */
    durationMs: number;
  } | null>(null);
  const [opError, setOpError] = useState<unknown>(null);
  const [preview, setPreview] = useState<number | null>(null);
  // Full-res preview URL per 1-based page number (F-23): the pick-grid
  // thumbs render at grid tier (~grid box), sharp in tiles but far too
  // small for the preview dialog — the dialog borrows the full-res render
  // (RearrangeTool parity) with the grid thumb as the loading fallback.
  // Service-owned borrows: never revoke, just drop the entry (the service
  // purges on close/evict).
  const [hiRes, setHiRes] = useState<Record<number, string>>({});
  const hiResRef = useRef(hiRes);
  hiResRef.current = hiRes;
  useEffect(() => {
    if (preview === null || !file) return;
    const pageNum = preview + 1;
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
  }, [preview, file, renderPreview]);
  const [showAll, setShowAll] = useState(false);
  const [fraction, setFraction] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const jobRef = useRef<StudioJob | null>(null);
  const [continuedFrom, setContinuedFrom] = useState<{
    producedBy: string;
    sourceName: string;
  } | null>(null);
  // Pending-transfer claim: same back-out-release discipline as
  // MergeTool/RearrangeTool (single doc here — extras are ignored, never
  // uploaded, never in state).
  const claimedRef = useRef<StudioDoc[]>([]);
  const ranRef = useRef(false);
  const mountGenRef = useRef(0);

  // Pending-transfer intake (mount once): the handed-off doc becomes the
  // single input by reference — verified live, never re-uploaded.
  useEffect(() => {
    mountGenRef.current += 1;
    const gen = mountGenRef.current;
    const pending = consumePendingTransfer();
    if (pending !== null) {
      const live = pending.docs.filter((d) => getStudioBytes(d.id) !== undefined);
      const firstDoc: StudioDoc | undefined = live.length > 0 ? live[0] : undefined;
      if (firstDoc !== undefined) {
        claimedRef.current = [firstDoc];
        setFiles((prev) => (prev.length > 0 ? prev : [firstDoc]));
        setContinuedFrom({ producedBy: pending.producedBy, sourceName: pending.sourceName });
      }
    }
    return () => {
      // Same deferred back-out release as MergeTool (P5-1 via closeStudioDoc).
      const claimed = claimedRef.current;
      window.setTimeout(() => {
        if (mountGenRef.current !== gen) return;
        claimedRef.current = claimedRef.current.filter((d) => !claimed.some((c) => c.id === d.id));
        if (ranRef.current) return;
        for (const d of claimed) void closeStudioDoc(d.id);
      }, 0);
    };
  }, [setFiles]);

  // Cancel the running job when the user navigates away.
  useEffect(
    () => () => {
      void jobRef.current?.cancel();
    },
    [],
  );

  useEffect(() => {
    setResult(null);
    setShowAll(false);
    setHiRes({});
    if (!file) {
      setKeep([]);
      setCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Pick-grid tier (F-23): tiles display far above list size, so the
        // window box is grid-derived — never the 64px-based list default.
        const t = await load(file.id, file.pageCount, PAGE_LIMIT, thumbGridBox());
        if (cancelled) return;
        setCount(t.length);
        setKeep(new Array(t.length).fill(true));
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

  const toggle = useCallback((i: number) => {
    setKeep((prev) => prev.map((v, idx) => (idx === i ? !v : v)));
  }, []);

  const keepCount = useMemo(() => keep.filter(Boolean).length, [keep]);
  const visibleThumbs = useMemo(() => {
    if (thumbs.length <= 30 || showAll) return thumbs;
    return thumbs.slice(0, PAGE_LIMIT);
  }, [thumbs, showAll]);
  const hiddenCount = thumbs.length - visibleThumbs.length;

  async function handleCreate() {
    if (!file) return;
    ranRef.current = true;
    setBusy(true);
    setError(null);
    setOpError(null);
    setResult(null);
    setFraction(null);
    setStage(null);
    try {
      if (mode === 'pick') {
        const kept = keep.map((v, i) => (v ? i + 1 : -1)).filter((i) => i >= 0);
        if (kept.length === 0) throw new Error('Select at least one page to keep');
        const job = runStudioOperation(
          'pdf.extract_pages',
          [file.id],
          { pages: kept },
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
        if (first === undefined) throw new Error('Split produced no output.');
        // Raw engine output by reference, labelled with the existing
        // smart part name — it doubles as the handoff `sourceName` feed:
        // `sourceName` stays the verbatim input name so the next tool
        // chains its smart name from the original, never stacked.
        setResult({
          sourceName: file.name,
          outputs: [
            { ...first, name: smartSplitPartName(file.name, kept[0], kept[kept.length - 1]) },
          ],
          durationMs: out.durationMs,
        });
      } else {
        const parsed = parseRanges(ranges);
        if (parsed.length === 0) throw new Error('Enter at least one page or range');
        const ranged = parsed
          .map(([a, b]) => ({
            range: [a, b] as [number, number],
            pages: rangeToList(a, b, file.pageCount),
          }))
          .filter((r) => r.pages.length > 0);
        if (ranged.length === 0)
          throw new Error(`Those pages are outside this ${file.pageCount}-page document.`);
        const job = runStudioOperation(
          'pdf.split',
          [file.id],
          { parts: ranged.map((r) => ({ pages: r.pages })) },
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
        if (out.outputs.length === 1) {
          const first = out.outputs[0];
          if (first === undefined) throw new Error('Split produced no output.');
          const [a, b] = ranged[0]?.range ?? [1, 1];
          setResult({
            sourceName: file.name,
            outputs: [{ ...first, name: smartSplitPartName(file.name, a, b) }],
            durationMs: out.durationMs,
          });
        } else {
          // Atomicity preserved: this single `pdf.split` call commits all
          // parts together — outputs surface only after every part
          // succeeds, never partially.
          const parts: StudioOutput[] = out.outputs.map((o, i) => {
            const [a, b] = ranged[Math.min(i, ranged.length - 1)]?.range ?? [1, 1];
            return { ...o, name: smartSplitPartName(file.name, a, b) };
          });
          setResult({ sourceName: file.name, outputs: parts, durationMs: out.durationMs });
        }
      }
    } catch (e) {
      jobRef.current = null;
      const code = (e as { code?: string }).code;
      if (code === 'CANCELLED') {
        setOpError(new Error('Split cancelled.'));
      } else {
        setOpError(e);
      }
    } finally {
      setBusy(false);
      setFraction(null);
      setStage(null);
    }
  }

  const onCancel = async () => {
    try {
      await jobRef.current?.cancel();
    } catch {
      // The job settles the UI via handleCreate's catch/finally.
    }
  };

  const handleBackToEdit = useCallback(() => {
    setResult(null);
  }, []);

  return (
    <div className="py-6">
      <ToolHeading
        icon={<SplitIcon />}
        name="Split"
        desc="Drop a PDF, then remove the pages you don't need — or extract exact ranges."
      />

      {!file && (
        <DropZone
          accept="application/pdf"
          multiple={false}
          onFiles={(f) => addFiles(f)}
          title="Drop a PDF to split"
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
            }}
          />

          <div className="flex gap-2" role="group" aria-label="Split mode">
            <button
              onClick={() => setMode('pick')}
              aria-pressed={mode === 'pick'}
              className={
                'flex-1 rounded-xl border px-4 py-2 min-h-[44px] text-sm transition-colors ' +
                (mode === 'pick'
                  ? 'border-brass-400 bg-brass-400/10 text-ink-900 dark:text-paper-100'
                  : 'border-paper-300 dark:border-ink-700 text-ink-400')
              }
            >
              Pick pages
            </button>
            <button
              onClick={() => setMode('ranges')}
              aria-pressed={mode === 'ranges'}
              className={
                'flex-1 rounded-xl border px-4 py-2 min-h-[44px] text-sm transition-colors ' +
                (mode === 'ranges'
                  ? 'border-brass-400 bg-brass-400/10 text-ink-900 dark:text-paper-100'
                  : 'border-paper-300 dark:border-ink-700 text-ink-400')
              }
            >
              By ranges
            </button>
          </div>

          {mode === 'pick' && (
            <>
              {loading && (
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-2 text-sm text-ink-400 dark:text-ink-300">
                    <Spinner /> Rendering pages…
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
              {!loading && (
                <Card>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
                      Tap the thumbnail to preview, tap the label to keep or remove.
                    </p>
                    <span className="text-xs font-mono tabular-nums rounded-full bg-paper-200/70 dark:bg-ink-900/60 px-2.5 py-1 text-ink-500 dark:text-ink-300">
                      {keepCount}/{count} kept
                    </span>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                    {visibleThumbs.map((src, i) => (
                      <ThumbTile
                        key={i}
                        src={src}
                        index={i}
                        kept={keep[i]}
                        onToggle={toggle}
                        onPreview={setPreview}
                      />
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        onClick={() => {
                          setShowAll(true);
                          void fillAll();
                        }}
                        className="rounded-lg border-2 border-dashed border-paper-300 dark:border-ink-700 flex flex-col items-center justify-center gap-1 aspect-[3/4] text-sm text-ink-500 hover:border-brass-400 hover:text-brass-600 transition-colors"
                      >
                        <span className="text-lg">+{hiddenCount}</span>
                        <span className="text-xs">
                          {progress && progress.done < progress.total
                            ? `Load more (${progress.done}/${progress.total})`
                            : thumbs.filter(Boolean).length < thumbs.length
                              ? 'Load more'
                              : 'Show all'}
                        </span>
                      </button>
                    )}
                  </div>
                  {thumbs.length > 30 && !showAll && (
                    <p className="text-xs text-ink-400 mt-3">
                      Showing {PAGE_LIMIT} of {thumbs.length} pages — click “Show all” for the rest.
                    </p>
                  )}
                  {showAll && thumbs.length > 30 && (
                    <button
                      onClick={() => setShowAll(false)}
                      className="mt-3 text-xs text-ink-400 hover:text-ink-700"
                    >
                      Show less
                    </button>
                  )}
                </Card>
              )}
            </>
          )}

          {mode === 'ranges' && (
            <Card>
              <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-2">
                Pages to extract
              </p>
              <input
                value={ranges}
                onChange={(e) => setRanges(e.target.value)}
                placeholder="e.g. 1-3, 5, 8-10"
                aria-label="Pages to extract"
                className="w-full rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-900 px-4 py-2.5 text-sm text-ink-900 dark:text-paper-100 outline-none focus:border-brass-400"
              />
              <p className="text-xs text-ink-400 mt-2">
                One file per range; ranges produce multiple downloads.
              </p>
            </Card>
          )}

          {!result && (
            <div className="flex items-center gap-3">
              <Button onClick={handleCreate} disabled={busy} className="w-full">
                {busy
                  ? 'Working…'
                  : mode === 'pick'
                    ? `Create PDF · ${keepCount} page${keepCount === 1 ? '' : 's'}`
                    : 'Extract pages'}
              </Button>
              {busy && (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </div>
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
              producedBy="split"
              onBackToEdit={handleBackToEdit}
              durationMs={result.durationMs}
            />
          )}
        </div>
      )}

      {filesError && <p className="mt-4 text-sm text-red-500">{filesError}</p>}
      {opError !== null && <ErrorBlock error={opError} />}

      <>
        {preview !== null &&
          thumbs[preview] &&
          // Portaled to document.body: the Card above carries no
          // `backdrop-filter` today, so in-tree `fixed` would work — but a
          // future refactor could nest this inside one (glass), which per
          // spec becomes the containing block for `fixed` descendants and
          // centers the dialog off-screen (F-19, cf. PageGrid). The portal
          // escapes every ancestor, so `fixed inset-0` is always the real
          // viewport. `dvh` caps keep the mobile URL bar from cropping.
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
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
              onClick={() => setPreview(null)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="max-w-3xl w-full max-h-[92dvh] flex flex-col overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-label={`Preview Page ${preview + 1}`}
              >
                <div className="flex items-center justify-between mb-2 text-paper-100 shrink-0">
                  <span className="font-display text-lg">Page {preview + 1}</span>
                  <button
                    onClick={() => setPreview(null)}
                    className="rounded-full bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
                  >
                    Close
                  </button>
                </div>
                <img
                  src={hiRes[preview + 1] ?? thumbs[preview]}
                  alt={
                    hiRes[preview + 1]
                      ? `Page ${preview + 1} (full resolution)`
                      : `Page ${preview + 1}`
                  }
                  className={
                    'w-full rounded-xl shadow-2xl bg-white object-contain max-h-[78dvh]' +
                    (hiRes[preview + 1] ? '' : ' opacity-80')
                  }
                />
                {!hiRes[preview + 1] && (
                  <p className="mt-2 text-center text-xs text-paper-100/80">
                    Rendering full-resolution view…
                  </p>
                )}
              </motion.div>
            </motion.div>,
            document.body,
          )}
      </>
    </div>
  );
}

/** Expands an inclusive 1-based range into a page list, validated against
 * the open document: endpoints clamp to `1..pageCount`, empty/outside
 * ranges yield `[]`, and length can never exceed `pageCount` (the engine
 * clamp stays the final backstop, but the UI never sends it megabytes of
 * redundant page numbers for a `1-999999` typo). */
function rangeToList(a: number, b: number, pageCount: number): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) return [];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  const start = Math.min(Math.max(1, Math.min(a, b)), pageCount);
  const end = Math.max(1, Math.min(Math.max(a, b), pageCount));
  if (start > end) return [];
  const out: number[] = [];
  for (let i = start; i <= end && out.length < pageCount; i += 1) out.push(i);
  return out;
}

function SplitIcon() {
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
      <path d="M12 3v18" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
    </svg>
  );
}
