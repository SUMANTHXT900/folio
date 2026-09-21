import { useEffect, useState, useMemo, memo, useCallback, useRef } from 'react';
import {
  ToolHeading,
  DropZone,
  FileChip,
  Button,
  Spinner,
  DoneBanner,
  Progress,
  ResultMeta,
  ErrorBlock,
} from '../components/ui';
import { usePdfFiles } from '../hooks/usePdfFiles';
import { usePageThumbs } from '../hooks/usePageThumbs';
import {
  closeStudioDoc,
  openStudioBytes,
  runStudioOperation,
  formatDurationMs,
  studioDownload,
  studioShareAvailable,
  studioStripExt,
  type StudioJob,
} from '../services/folio';
import { formatBytes } from '../components/ui';

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
    <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.75 1 6.4 2.6L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

const PAGE_LIMIT = 24;

const RotateTile = memo(function RotateTile({
  src,
  idx,
  angle,
  onLeft,
  onRight,
}: {
  src: string;
  idx: number;
  angle: number;
  onLeft: () => void;
  onRight: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="w-full aspect-[3/4] rounded-lg overflow-hidden border-2 border-paper-300 dark:border-ink-700 bg-white relative"
        style={{ transform: `rotate(${angle}deg)`, transition: 'transform .2s' }}
      >
        {src ? (
          <img
            src={src}
            alt={`Page ${idx + 1}`}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-scale-down"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-ink-400 animate-pulse">
            …
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={onLeft}
          className="w-8 h-8 rounded-lg border border-paper-300 dark:border-ink-700 flex items-center justify-center text-sm hover:bg-paper-200 dark:hover:bg-ink-800 transition-colors"
          aria-label="Rotate left"
        >
          ↺
        </button>
        <span className="w-6 text-center text-xs font-medium text-ink-400">{idx + 1}</span>
        <button
          onClick={onRight}
          className="w-8 h-8 rounded-lg border border-paper-300 dark:border-ink-700 flex items-center justify-center text-sm hover:bg-paper-200 dark:hover:bg-ink-800 transition-colors"
          aria-label="Rotate right"
        >
          ↻
        </button>
      </div>
    </div>
  );
});

export default function RotateTool() {
  const { files, addFiles, remove } = usePdfFiles();
  const file = files[0] ?? null;
  const { thumbs, load, fillAll, loading } = usePageThumbs();

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    (async () => {
      try {
        await load(file.id, file.pageCount, PAGE_LIMIT);
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

  const [rot, setRot] = useState<Record<number, number>>({});
  const [allRot, setAllRot] = useState(0);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<{ name: string; blob: Blob } | null>(null);
  const [meta, setMeta] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [showAll, setShowAll] = useState(false);
  const [fraction, setFraction] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const jobRef = useRef<StudioJob | null>(null);

  const visibleIndices = useMemo(() => {
    const n = thumbs.length;
    if (n <= 30 || showAll) return Array.from({ length: n }, (_, i) => i);
    return Array.from({ length: PAGE_LIMIT }, (_, i) => i);
  }, [thumbs.length, showAll]);
  const hiddenCount = thumbs.length - visibleIndices.length;

  const spinOne = useCallback((pageIndex: number, delta: number) => {
    setRot((r) => ({ ...r, [pageIndex]: ((((r[pageIndex] || 0) + delta) % 4) + 4) % 4 }));
  }, []);

  const spinAll = useCallback((delta: number) => {
    setAllRot((a) => (((a + delta) % 4) + 4) % 4);
  }, []);

  const onDownload = async () => {
    if (!file) return;
    setWorking(true);
    setError(null);
    setDone(null);
    setMeta([]);
    setFraction(null);
    setStage(null);
    let currentTemp: string | null = null;
    let totalDurationMs = 0;
    let lastPageCount: number | null = null;
    let lastByteLength = 0;
    try {
      // Fold pending global turns into the per-page map (preview parity).
      const final: Record<number, number> = { ...rot };
      if (allRot !== 0) {
        for (let idx = 0; idx < file.pageCount; idx += 1) {
          final[idx] = ((((final[idx] || 0) + allRot) % 4) + 4) % 4;
        }
      }
      // The engine rotates one angle per call: group pages by turns and
      // chain up to three runs over intermediate in-memory documents.
      const groups = [1, 2, 3]
        .map((turns) => ({
          angleDeg: turns * 90,
          pages: Object.entries(final)
            .filter(([, t]) => t === turns)
            .map(([idx]) => Number(idx) + 1),
        }))
        .filter((group) => group.pages.length > 0);
      let currentId = file.id;
      for (let gi = 0; gi < groups.length; gi += 1) {
        const group = groups[gi];
        const job = runStudioOperation(
          'pdf.rotate',
          [currentId],
          { pages: group.pages, angleDeg: group.angleDeg },
          {
            onProgress: (p) => {
              const base = gi / groups.length;
              const span = 1 / groups.length;
              setFraction(base + (p.fraction ?? 0) * span);
              setStage(
                groups.length > 1
                  ? `Step ${gi + 1} of ${groups.length} (${group.angleDeg}°) — ${p.label}`
                  : p.label,
              );
            },
          },
        );
        jobRef.current = job;
        let out;
        try {
          out = await job.done;
        } catch (e) {
          // Preserve engine code/message/details and cancellation; add only
          // which chained step failed (no temp-document internals).
          const code = (e as { code?: string }).code;
          if (code === 'CANCELLED') throw e;
          const stepNote =
            groups.length > 1 ? ` (step ${gi + 1} of ${groups.length}, ${group.angleDeg}°)` : '';
          const wrapped = new Error(
            `${e instanceof Error ? e.message : 'Rotate failed'}${stepNote}`,
          );
          (wrapped as { code?: string }).code = code ?? 'INTERNAL';
          (wrapped as { details?: string }).details = (e as { details?: string }).details;
          (wrapped as { engineMessage?: string }).engineMessage = (
            e as { engineMessage?: string }
          ).engineMessage;
          throw wrapped;
        }
        const first = out.outputs[0];
        totalDurationMs += out.durationMs;
        lastPageCount = first.pageCount;
        lastByteLength = first.byteLength;
        if (gi < groups.length - 1) {
          const temp = await openStudioBytes(`${file.name} (step ${gi + 1})`, first.bytes);
          if (currentTemp !== null) {
            await closeStudioDoc(currentTemp).catch(() => undefined);
          }
          currentTemp = temp.id;
          currentId = temp.id;
        } else {
          const name = `${studioStripExt(file.name)}-rotated.pdf`;
          studioDownload(first.bytes, name);
          setDone({
            name,
            blob: new Blob([first.bytes as unknown as BlobPart], { type: 'application/pdf' }),
          });
          const summary = out.summary;
          const pages =
            summary !== undefined && 'pageCount' in summary
              ? summary.pageCount
              : (lastPageCount ?? file.pageCount);
          setMeta([
            `${pages} pages`,
            `${formatBytes(lastByteLength)}`,
            `Completed in ${formatDurationMs(totalDurationMs)}`,
          ]);
        }
      }
      jobRef.current = null;
    } catch (e) {
      jobRef.current = null;
      const code = (e as { code?: string }).code;
      if (code === 'CANCELLED') {
        setError(new Error('Rotate cancelled.'));
      } else {
        setError(e);
      }
    } finally {
      setWorking(false);
      setFraction(null);
      setStage(null);
      if (currentTemp !== null) {
        await closeStudioDoc(currentTemp).catch(() => undefined);
      }
    }
  };

  const onCancel = async () => {
    try {
      await jobRef.current?.cancel();
    } catch {
      // The job settles the UI via onDownload's catch/finally.
    }
  };

  // Cancel the running job when the user navigates away
  useEffect(
    () => () => {
      void jobRef.current?.cancel();
    },
    [],
  );

  return (
    <div>
      <ToolHeading
        icon={ICON}
        name="Rotate pages"
        desc="Rotate individual pages or the whole document."
      />

      {!file ? (
        <DropZone
          accept="application/pdf"
          onFiles={addFiles}
          title="Drop a PDF to rotate"
          cta="Select PDF"
        />
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="flex-none">
              <FileChip
                name={file.name}
                size={file.sizeBytes}
                onRemove={() => {
                  setRot({});
                  setAllRot(0);
                  remove(file.id);
                }}
              />
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setRot((r) => {
                  const next = { ...r };
                  thumbs.forEach((_, idx) => {
                    next[idx] = ((((next[idx] || 0) + allRot) % 4) + 4) % 4;
                  });
                  return next;
                });
                setAllRot(0);
              }}
              disabled={working || !allRot}
            >
              Apply all
            </Button>
            <Button variant="ghost" onClick={() => spinAll(1)} disabled={working}>
              ↻ All +90°
            </Button>
            <Button variant="ghost" onClick={() => spinAll(-1)} disabled={working}>
              ↺ All −90°
            </Button>
          </div>

          {allRot !== 0 && (
            <p className="text-xs text-brass-500 mb-3">
              ＋{allRot * 90}° to every page — press “Apply all” to preview, or Download.
            </p>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-ink-400">
              <Spinner /> Rendering previews…
            </div>
          )}

          {!loading && thumbs.length > 0 && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {visibleIndices.map((idx) => {
                  const angle = (rot[idx] || 0) * 90;
                  return (
                    <RotateTile
                      key={idx}
                      src={thumbs[idx]}
                      idx={idx}
                      angle={angle}
                      onLeft={() => spinOne(idx, -1)}
                      onRight={() => spinOne(idx, 1)}
                    />
                  );
                })}
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
                      {thumbs.filter(Boolean).length < thumbs.length ? 'Load more' : 'Show all'}
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
            </>
          )}

          <div className="mt-8 flex items-center gap-3">
            <Button onClick={onDownload} disabled={working || thumbs.length === 0}>
              Download rotated PDF
            </Button>
            {working ? (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            ) : (
              <button
                onClick={() => {
                  setRot({});
                  setAllRot(0);
                }}
                className="ml-1 text-sm text-ink-400 hover:text-ink-900 dark:hover:text-paper-100"
              >
                Reset
              </button>
            )}
          </div>
          {working && fraction !== null && (
            <div className="mt-3 w-full max-w-xs">
              <Progress value={fraction * 100} label={stage ?? 'Rotating…'} />
            </div>
          )}

          {working && <Spinner label={stage ?? 'Rotating…'} />}
          {done && (
            <div className="mt-6">
              <DoneBanner name={done.name} blob={done.blob} shareable={studioShareAvailable()} />
              <ResultMeta lines={meta} />
            </div>
          )}
          {error !== null && <ErrorBlock error={error} />}
        </>
      )}
    </div>
  );
}
