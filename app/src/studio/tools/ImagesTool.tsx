import { useRef, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ToolHeading,
  Button,
  Card,
  Progress,
  ResultMeta,
  ErrorBlock,
  formatBytes,
} from '../components/ui';
import { DownloadCard } from '../components/DownloadCard';
import { smartOutputName } from '../components/downloadNaming';
import {
  releaseStagedBytes,
  formatDurationMs,
  stageStudioBytes,
  studioShareAvailable,
  type StudioJob,
} from '../services/folio';
import { buildImagesPdf, resolveShardCount } from './imageSharding';
import { useImagePages } from './useImagePages';
import { PageGrid } from './PageGrid';
import ScanicCapture, { type ScanicCommittedPage } from './ScanicCapture';
import { browserImageRenderer, preparePageBytes, type ImageRenderer } from './imagePrepare';
import type { ImagePage } from './imagePages';

const ICON = (
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
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.5-3.5a2 2 0 0 0-3 0L6 20" />
  </svg>
);

const ACCEPT = 'image/jpeg,image/png,.jpg,.jpeg,.png';

/**
 * Build-loop staging: prepares pages SEQUENTIALLY in collection order
 * (ordering/sharding semantics unchanged — the staged array that feeds
 * `buildImagesPdf` is identical, only the loop reports progress).
 * Mirrors the import-queue pattern (`imageImport.runImportQueue`): one
 * page at a time, `onStagingProgress(completed, total)` after each page,
 * and a `setTimeout(0)` yield between pages so the staging progress can
 * paint instead of blocking the main thread through a large batch.
 * Exported for unit tests; the tool wires it to `stage`/`fraction`.
 */
export async function stageImagePages(
  pages: readonly ImagePage[],
  renderer: ImageRenderer,
  onStagingProgress?: (completed: number, total: number) => void,
): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const staged: Array<{ name: string; bytes: Uint8Array }> = [];
  for (let i = 0; i < pages.length; i += 1) {
    const prepared = await preparePageBytes(pages[i], renderer);
    staged.push(prepared);
    onStagingProgress?.(i + 1, pages.length);
    // Yield: keeps React paint + input responsive between files.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return staged;
}

/**
 * Pre-stage sharding policy (M5): evaluates `resolveShardCount` on
 * pre-stage sums — Σ `file.size` bytes plus Σ known w×h pixels — BEFORE
 * the prepare loop materializes staged
 * bytes. Pages with known normalized dims (import path) feed the pixel
 * gate with real decode cost; raw handles (dims 0) count as zero and the
 * byte gate still bounds exactly as before; the page-count gate runs
 * first, so small batches keep the single-worker path byte-for-byte.
 * Exported for unit tests.
 */
export function preStageShardEstimate(
  pages: readonly { file: File | Blob; size: number; width?: number; height?: number }[],
): {
  totalBytes: number;
  totalPixels: number;
  shards: number;
} {
  const totalBytes = pages.reduce((sum, p) => sum + Math.max(0, p.file?.size ?? p.size ?? 0), 0);
  const totalPixels = pages.reduce(
    (sum, p) =>
      sum +
      (p.width !== undefined && p.height !== undefined && p.width > 0 && p.height > 0
        ? p.width * p.height
        : 0),
    0,
  );
  return {
    totalBytes,
    totalPixels,
    shards: resolveShardCount(pages.length, { totalBytes, totalPixels }),
  };
}

/**
 * Images → PDF page assembly: uploads join one ordered page collection
 * (preview, reorder, remove, rotate), then build through the Folio engine
 * (`pdf.images_to_pdf`, one page per image, in listed order). Image bytes
 * are staged in the service store only for the run (never in React state);
 * pages hold File/Blob handles + preview URLs. Uploads share the entry
 * card with the scanic camera entry below: committed camera pages arrive
 * pre-named `scan-NNN.jpg` in capture order (`source: 'camera'`) and join
 * the same collection via `addFiles` — handles only, no normalization, so
 * the gallery upload path stays byte-identical.
 */
export default function ImagesTool() {
  const { pages, importFiles, move, remove, rotate, clear, reorder, addFiles } = useImagePages();
  const [pageSize, setPageSize] = useState<'fit' | 'standard'>('fit');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<{ name: string; blob: Blob } | null>(null);
  const [meta, setMeta] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  // Single progress object (staging + engine share it): one state update
  // per progress tick instead of two staggered setter passes. Fraction is
  // null while the engine reports indeterminate progress (same as before).
  const [progress, setProgress] = useState<{ fraction: number | null; label: string } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const jobRef = useRef<StudioJob | null>(null);
  const moreInputRef = useRef<HTMLInputElement>(null);
  // True only while a completed build's card is displayed: collection or
  // page-size changes invalidate the card ONLY then (order-affecting change
  // postdating the build). Stale-build teardown can never wipe a fresh run.
  const completedBuildRef = useRef(false);

  // Scanic camera reintegration: committed pages are pre-named `scan-NNN.jpg`
  // in capture order. `addFiles` appends handles in array order with no
  // normalization — the committed bytes (warped PNG or untouched original)
  // reach the collection byte-identical, and numbering continues past any
  // camera pages already in the collection.
  const commitCameraPages = (committed: ScanicCommittedPage[]) => {
    if (committed.length > 0) {
      addFiles(
        committed.map((p) => p.file),
        'camera',
      );
    }
    setScannerOpen(false);
  };
  const cameraStartIndex = pages.filter((p) => p.source === 'camera').length;

  const addUploads = async (incoming: File[]) => {
    // Shared normalized import path: pixel-budget resize + PNG→JPEG
    // conversion, one file at a time. Raw gallery PNGs would otherwise
    // embed as uncompressed RGB downstream (100 MB+ PDFs).
    setImporting('Preparing images…');
    try {
      const summary = await importFiles(incoming, 'upload', {
        onProgress: (completed, total) =>
          setImporting(`Preparing images… ${completed} of ${total}`),
      });
      if (summary.skipped > 0) {
        setError(new Error('Skipped non-image file(s) — JPEG and PNG only.'));
      } else if (summary.failed > 0) {
        setError(
          new Error(
            summary.firstError !== null
              ? `Couldn't add ${summary.failed} image(s): ${summary.firstError}`
              : `Couldn't add ${summary.failed} image(s).`,
          ),
        );
      } else {
        setError(null);
      }
    } finally {
      setImporting(null);
    }
  };

  // Rejection-safe upload entry: `addUploads` runs async decode work that
  // can reject; every call site funnels through here so a dropped promise
  // never surfaces as an unhandled rejection.
  const handleFiles = (files: File[]) => {
    void addUploads(files).catch(setError);
  };

  // A completed PDF is stale the moment the collection or page-size
  // policy changes (import/remove/reorder/rotate/clear) — but ONLY when a
  // completed build exists. Guarded by `completedBuildRef` so the effect
  // is a no-op during assembly and can never clear a fresh run: clearing
  // the completion card brings Build PDF back AND releases the previous
  // output Blob (P2).
  useEffect(() => {
    if (!completedBuildRef.current) return;
    completedBuildRef.current = false;
    setDone(null);
    setMeta([]);
  }, [pages, pageSize]);

  const onBuild = async () => {
    if (pages.length === 0) return;
    completedBuildRef.current = false;
    setWorking(true);
    setError(null);
    setDone(null);
    setMeta([]);
    setProgress(null);
    const staged: string[] = [];
    const stagedSizes: number[] = [];
    try {
      // M5: pre-stage policy on pre-stage sums (single source of truth for
      // the decision lives in `buildImagesPdf`'s post-stage evaluation;
      // small batches agree by construction — see `preStageShardEstimate`).
      const preStage = preStageShardEstimate(pages);
      if (import.meta.env.DEV) {
        console.debug(
          `[folio-images] pre-stage policy: ${pages.length} pages, ${preStage.totalBytes} bytes → ${preStage.shards} shard(s)`,
        );
      }
      const prepared = await stageImagePages(pages, browserImageRenderer, (completed, total) => {
        setProgress({
          fraction: completed / total,
          label: `Preparing images… ${completed} of ${total}`,
        });
      });
      for (const item of prepared) {
        stagedSizes.push(item.bytes.length);
        staged.push(stageStudioBytes(item.name, item.bytes));
      }
      // P3 item 13: large batches shard across parallel shard jobs +
      // ordered merge (imageSharding); small batches keep the historical
      // single-worker engine call byte-for-byte inside that module.
      // Known normalized dims ride along as the pixel gate's decode-cost
      // input (raw handles carry 0 and keep the byte-only behavior).
      const stagedPixels = pages.map((p) => (p.width > 0 && p.height > 0 ? p.width * p.height : 0));
      const job = buildImagesPdf({
        stagedIds: staged,
        stagedSizes,
        stagedPixels,
        pageSize,
        onProgress: (p) => {
          setProgress({ fraction: p.fraction, label: p.label });
        },
      });
      jobRef.current = job;
      const out = await job.done;
      jobRef.current = null;
      const first = out.outputs[0];
      const name = smartOutputName(
        'images',
        pages.map((p) => p.name),
      );
      // ONE Blob for download, re-download, and share (P2): the
      // engine output bytes are not retained afterwards, and no second
      // Blob is built. DownloadCard owns its object URL (revoked on
      // replace/unmount); no auto-download fires — the card's anchor
      // is the trigger. The Blob stays only while this completion card
      // is displayed — required for save-again/share; cleared on
      // rebuild, clear, unmount.
      const blob = new Blob([first.bytes as unknown as BlobPart], { type: 'application/pdf' });
      setDone({ name, blob });
      completedBuildRef.current = true;
      const summary = out.summary;
      const imageCount =
        summary !== undefined && 'imageCount' in summary && typeof summary.imageCount === 'number'
          ? summary.imageCount
          : pages.length;
      const pageCount =
        summary !== undefined && 'pageCount' in summary ? summary.pageCount : imageCount;
      setMeta([
        `${imageCount} image${imageCount === 1 ? '' : 's'} → ${pageCount}-page PDF`,
        `${formatBytes(first.byteLength)}`,
        `Completed in ${formatDurationMs(out.durationMs)}`,
      ]);
    } catch (e) {
      jobRef.current = null;
      const code = (e as { code?: string }).code;
      if (code === 'CANCELLED') {
        setError(new Error('Image build cancelled.'));
      } else {
        setError(e);
      }
    } finally {
      setWorking(false);
      setProgress(null);
      for (const id of staged) releaseStagedBytes(id);
    }
  };

  const onCancel = async () => {
    try {
      await jobRef.current?.cancel();
    } catch {
      // The job settles the UI via onBuild's catch/finally.
    }
  };

  return (
    <div className="py-6">
      <ToolHeading
        icon={ICON}
        name="Images to PDF"
        desc="Assemble pages from image files, arrange them in order, then build one PDF."
      />

      {pages.length === 0 ? (
        <div className="space-y-4">
          <EntryCard onFiles={handleFiles} onScan={() => setScannerOpen(true)} />
          {error !== null && <ErrorBlock error={error} />}
        </div>
      ) : (
        <div className="space-y-5">
          <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink-700 dark:text-paper-100">
                {pages.length} page{pages.length === 1 ? '' : 's'} · top-to-bottom is PDF order
              </p>
              <button
                onClick={clear}
                className="shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-ink-300 dark:hover:bg-red-950/30"
              >
                Clear all
              </button>
            </div>
            <PageGrid
              pages={pages}
              onMove={move}
              onReorder={reorder}
              onRemove={remove}
              onRotate={rotate}
            />
            <div className="mt-4 flex flex-wrap gap-2">
              <input
                ref={moreInputRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => {
                  handleFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {importing !== null && (
                <p role="status" className="text-xs text-ink-400 dark:text-ink-300">
                  {importing}
                </p>
              )}
              <Button variant="ghost" onClick={() => moreInputRef.current?.click()}>
                Add images
              </Button>
              <button
                type="button"
                data-scan-open
                onClick={() => setScannerOpen(true)}
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-paper-300 px-5 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-200 hover:border-brass-400/30 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-800"
              >
                Scan
              </button>
            </div>
            <p className="mb-3 mt-4 text-sm font-medium text-ink-700 dark:text-paper-100">
              Page size policy
            </p>
            <div className="flex gap-4 text-sm" role="radiogroup" aria-label="Page size policy">
              <label className="flex min-h-[44px] items-center gap-1.5">
                <input
                  type="radio"
                  name="studio-images-page-size"
                  checked={pageSize === 'fit'}
                  onChange={() => setPageSize('fit')}
                />
                Fit image (page = image size)
              </label>
              <label className="flex min-h-[44px] items-center gap-1.5">
                <input
                  type="radio"
                  name="studio-images-page-size"
                  checked={pageSize === 'standard'}
                  onChange={() => setPageSize('standard')}
                />
                A4 (fit inside, centered)
              </label>
            </div>
          </Card>

          {!done && pages.length > 0 && (
            <div className="flex items-center gap-3">
              <Button onClick={onBuild} disabled={working} className="w-full">
                {working
                  ? 'Building…'
                  : `Build PDF · ${pages.length} image${pages.length === 1 ? '' : 's'}`}
              </Button>
              {working && (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </div>
          )}
          {working && progress !== null && progress.fraction !== null && (
            <div className="w-full max-w-xs">
              <Progress value={progress.fraction * 100} label={progress.label} />
            </div>
          )}

          {error !== null && <ErrorBlock error={error} />}
          {done && (
            <>
              <DownloadCard
                blob={done.blob}
                suggestedName={done.name}
                shareable={studioShareAvailable()}
              />
              <ResultMeta lines={meta} />
            </>
          )}
        </div>
      )}
      {/* Full-screen takeover: ScanicCapture portals itself to document.body. */}
      {scannerOpen && (
        <ScanicCapture
          startIndex={cameraStartIndex}
          onCommit={commitCameraPages}
          onExit={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}

const ease = [0.22, 1, 0.36, 1] as const;

/**
 * Upload entry card: the whole card is a drop target (drag-over
 * spotlights the upload tile); the tiles stagger in, lift on hover, and
 * compress on tap. Upload tile + scan tile: gallery files and camera
 * captures join the same ordered collection.
 */
function EntryCard({ onFiles, onScan }: { onFiles: (files: File[]) => void; onScan: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const tiles = (
    <>
      <motion.button
        type="button"
        onClick={() => inputRef.current?.click()}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease, delay: 0.08 }}
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.97 }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        className={`group relative flex flex-1 flex-col items-center gap-2.5 overflow-hidden rounded-2xl border-2 border-dashed px-4 py-7 text-center transition-colors sm:py-9 ${
          over
            ? 'border-brass-400 bg-brass-400/[0.1] shadow-[0_0_0_5px_color-mix(in_srgb,var(--color-brass-400)_16%,transparent)]'
            : 'border-brass-500/35 hover:border-brass-400/60 hover:bg-brass-400/[0.04] dark:border-brass-400/25'
        }`}
      >
        <motion.span
          animate={over ? { scale: 1.1, rotate: -4 } : { scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
          className={`flex items-center justify-center rounded-2xl p-3 shadow-sm ring-1 transition-colors ${
            over
              ? 'bg-brass-400 text-white ring-brass-400/40'
              : 'bg-ink-900 text-paper-50 ring-black/5 group-hover:bg-brass-500 dark:bg-paper-100 dark:text-ink-900 dark:ring-white/10'
          }`}
          aria-hidden
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.5-3.5a2 2 0 0 0-3 0L6 20" />
          </svg>
        </motion.span>
        <span>
          <span className="block font-display text-base font-semibold text-ink-900 dark:text-paper-100">
            Upload images
          </span>
          <span className="mt-1 block text-xs text-ink-500 dark:text-ink-300">
            Gallery, screenshots, downloads
          </span>
        </span>
        <AnimatePresence>
          {over && (
            <motion.span
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="text-[11px] font-semibold uppercase tracking-wider text-brass-600 dark:text-brass-300"
            >
              release to add
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
      <motion.button
        type="button"
        data-scan-open
        onClick={onScan}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease, delay: 0.14 }}
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.97 }}
        className="group relative flex flex-1 flex-col items-center gap-2.5 overflow-hidden rounded-2xl border-2 border-dashed border-brass-500/35 px-4 py-7 text-center transition-colors hover:border-brass-400/60 hover:bg-brass-400/[0.04] sm:py-9 dark:border-brass-400/25"
      >
        <motion.span
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
          className="flex items-center justify-center rounded-2xl bg-ink-900 p-3 text-paper-50 shadow-sm ring-1 ring-black/5 transition-colors group-hover:bg-brass-500 dark:bg-paper-100 dark:text-ink-900 dark:ring-white/10"
          aria-hidden
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </motion.span>
        <span>
          <span className="block font-display text-base font-semibold text-ink-900 dark:text-paper-100">
            Scan document
          </span>
          <span className="mt-1 block text-xs text-ink-500 dark:text-ink-300">
            Camera capture, auto-cropped
          </span>
        </span>
      </motion.button>
    </>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
      className="relative overflow-hidden rounded-2xl border border-paper-300/70 bg-paper-50/85 p-4 shadow-soft sm:p-5 dark:border-ink-700 dark:bg-ink-800/60"
    >
      {/* subtle grid */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05] dark:opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, var(--color-brass-500) 1px, transparent 0)',
          backgroundSize: '20px 20px',
        }}
      />
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          void onFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <p className="relative mb-3 text-center font-display text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100">
        Add pages
      </p>
      <div className="relative flex flex-col gap-3 sm:flex-row">{tiles}</div>
      <p className="relative mt-3 text-center text-[11px] text-ink-400 dark:text-ink-300">
        100% on-device — files never leave your browser.
      </p>
      {/* AGENT11 copy (literal, short): bulk-import pacing hint. */}
      <p className="relative mt-1 text-center text-[11px] text-ink-400 dark:text-ink-300">
        Photos decode one at a time, so large batches take a moment.
      </p>
    </motion.div>
  );
}
