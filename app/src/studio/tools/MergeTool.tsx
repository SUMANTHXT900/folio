import { useEffect, useRef, useState } from 'react';
import { Reorder } from 'framer-motion';
import {
  ToolHeading,
  DropZone,
  Button,
  DoneBanner,
  StageLine,
  Progress,
  ResultMeta,
  ErrorBlock,
  formatBytes,
} from '../components/ui';
import { usePdfFiles } from '../hooks/usePdfFiles';
import {
  runStudioOperation,
  formatDurationMs,
  studioDownload,
  studioShareAvailable,
  studioStripExt,
  type StudioJob,
} from '../services/folio';

const MERGE_ICON = (
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
    <path d="M3 6h18M3 12h12M3 18h6" />
  </svg>
);

export default function MergeTool() {
  const { files, setFiles, addFiles, remove, clear, notice } = usePdfFiles();
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<{ name: string; blob: Blob } | null>(null);
  const [meta, setMeta] = useState<Array<string | null>>([]);
  const [error, setError] = useState<unknown>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  const jobRef = useRef<StudioJob | null>(null);

  const onMerge = async () => {
    if (files.length < 2) return;
    setWorking(true);
    setDone(null);
    setMeta([]);
    setError(null);
    setFraction(null);
    try {
      const job = runStudioOperation(
        'pdf.merge',
        files.map((f) => f.id),
        {},
        {
          onProgress: (p) => {
            setStage(p.label);
            setFraction(p.fraction);
          },
        },
      );
      jobRef.current = job;
      const result = await job.done;
      jobRef.current = null;
      const out = result.outputs[0];
      const name = `merged-${studioStripExt(files[0].name)}-${files.length}.pdf`;
      studioDownload(out.bytes, name);
      setDone({
        name,
        blob: new Blob([out.bytes as unknown as BlobPart], { type: 'application/pdf' }),
      });
      const summary = result.summary;
      setMeta([
        'inputDocumentCount' in summary
          ? `${summary.inputDocumentCount} document${summary.inputDocumentCount === 1 ? '' : 's'}`
          : null,
        'inputPageCount' in summary && typeof summary.inputPageCount === 'number'
          ? `${summary.inputPageCount} input page${summary.inputPageCount === 1 ? '' : 's'}`
          : null,
        'outputPageCount' in summary && typeof summary.outputPageCount === 'number'
          ? `${summary.outputPageCount} output page${summary.outputPageCount === 1 ? '' : 's'}`
          : `${out.pageCount ?? 0} pages`,
        `${formatBytes(out.byteLength)}`,
        `Completed in ${formatDurationMs(result.durationMs)}`,
      ]);
    } catch (e: unknown) {
      const code = e instanceof Error ? (e as { code?: string }).code : undefined;
      if (code === 'CANCELLED') {
        setError(new Error('Merge cancelled.'));
      } else {
        setError(e);
      }
    } finally {
      setWorking(false);
      setStage(null);
      setFraction(null);
      jobRef.current = null;
    }
  };

  const onCancel = async () => {
    try {
      await jobRef.current?.cancel();
    } catch {
      // The job settles the UI via onMerge's catch/finally.
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
        icon={MERGE_ICON}
        name="Merge PDFs"
        desc="Combine two or more PDF files into a single document. Drag rows to set the order before merging."
      />

      {files.length === 0 ? (
        <DropZone
          accept="application/pdf"
          multiple
          onFiles={addFiles}
          title="Drop your PDFs here"
          cta="Select PDFs"
        />
      ) : (
        <>
          {/* file list */}
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
              {files.length} file{files.length > 1 ? 's' : ''} · ready to merge
            </p>
            <button
              onClick={clear}
              className="text-xs text-ink-400 hover:text-red-500 dark:text-ink-300 transition-colors px-2 py-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              Clear all
            </button>
          </div>

          <Reorder.Group
            axis="y"
            values={files}
            onReorder={setFiles}
            className="flex flex-col gap-2 mb-6"
          >
            {files.map((f, i) => (
              <Reorder.Item
                key={f.id}
                value={f}
                className="list-none relative"
                whileDrag={{ scale: 1.015, boxShadow: '0 12px 28px -12px rgba(23,19,14,0.25)' }}
              >
                <div className="flex items-center gap-3 rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-800 px-2 pl-3 py-3 cursor-grab active:cursor-grabbing select-none">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="text-ink-300 dark:text-ink-500 shrink-0"
                    aria-hidden
                  >
                    <circle cx="12" cy="6" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="12" cy="18" r="1.6" />
                  </svg>
                  <span className="w-6 text-sm font-mono text-brass-600 dark:text-brass-300 shrink-0 tabular-nums">
                    {i + 1}
                  </span>
                  <span className="w-9 h-9 rounded-lg bg-brass-400/15 text-brass-600 dark:text-brass-300 hidden sm:flex items-center justify-center shrink-0">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-900 dark:text-paper-100 truncate">
                      {f.name}
                    </p>
                    <p className="text-xs text-ink-400 dark:text-ink-300">
                      {formatBytes(f.sizeBytes)} · {f.pageCount} pages
                    </p>
                  </div>
                  <button
                    onClick={() => remove(f.id)}
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-ink-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors shrink-0"
                    aria-label={`Remove ${f.name}`}
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
              </Reorder.Item>
            ))}
          </Reorder.Group>

          {/* actions */}
          <div className="flex items-center gap-3">
            <Button onClick={onMerge} disabled={files.length < 2 || working}>
              {working ? (
                'Merging…'
              ) : (
                <>
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18M3 12h12M3 18h6" />
                  </svg>
                  Merge {files.length} files
                </>
              )}
            </Button>
            {working ? (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            ) : (
              <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-brass-500/40 dark:border-brass-400/30 text-ink-600 dark:text-paper-100 px-5 py-2.5 text-sm font-medium hover:bg-brass-400/[0.07] hover:border-brass-400/60 transition-colors">
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
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add more
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  hidden
                  onChange={(e) => {
                    const fs = Array.from(e.target.files || []);
                    if (fs.length) addFiles(fs);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>

          {working && stage && <StageLine stage={stage} />}
          {working && fraction !== null && (
            <div className="mt-3">
              <Progress value={fraction * 100} label={stage ?? undefined} />
            </div>
          )}

          {notice && (
            <p className="mt-3 text-xs text-brass-600 dark:text-brass-300 bg-brass-400/[0.07] rounded-xl px-4 py-2.5 border border-brass-500/25">
              {notice}
            </p>
          )}

          {files.length < 2 && !working && (
            <p className="mt-3 text-xs text-ink-400 dark:text-ink-300">
              Add at least one more PDF to merge.
            </p>
          )}

          {error !== null && <ErrorBlock error={error} />}
          {done && (
            <>
              <DoneBanner name={done.name} blob={done.blob} shareable={studioShareAvailable()} />
              <ResultMeta lines={meta} />
            </>
          )}
        </>
      )}
    </div>
  );
}
