import { useEffect, useState, useRef } from 'react';
import {
  ToolHeading,
  DropZone,
  FileChip,
  Button,
  Spinner,
  Card,
  Progress,
  ResultMeta,
  ErrorBlock,
  formatBytes,
} from '../components/ui';
import { DownloadCard } from '../components/DownloadCard';
import { smartOutputName } from '../components/downloadNaming';
import { usePdfFiles } from '../hooks/usePdfFiles';
import {
  closeStudioDoc,
  openStudioBytes,
  runStudioOperation,
  formatDurationMs,
  studioShareAvailable,
  type StudioJob,
} from '../services/folio';
import type { DocumentMetadataData, PdfDateData } from '../../types/engine';
import { parseMetadataDate } from '../../utils/parse';

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
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

function formatDate(date: PdfDateData): string {
  const pad = (v: number, w = 2): string => String(v).padStart(w, '0');
  const sign = date.tzOffsetMinutes < 0 ? '-' : '+';
  const mag = Math.abs(date.tzOffsetMinutes);
  const zone =
    date.tzOffsetMinutes === 0 ? '+0000' : `${sign}${pad(Math.floor(mag / 60))}${pad(mag % 60)}`;
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)} ${pad(date.hour)}:${pad(date.minute)}:${pad(date.second)} ${zone}`;
}

const TEXT_FIELDS = [
  { key: 'title', label: 'Title' },
  { key: 'author', label: 'Author' },
  { key: 'subject', label: 'Subject' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'creator', label: 'Creator' },
  { key: 'producer', label: 'Producer' },
] as const;

const DATE_FIELDS = [
  { key: 'creationDate', label: 'Creation date' },
  { key: 'modificationDate', label: 'Modification date' },
] as const;

type TextKey = (typeof TEXT_FIELDS)[number]['key'];
type DateKey = (typeof DATE_FIELDS)[number]['key'];

/**
 * Document properties tool: reads typed metadata through the Folio
 * engine and writes patches (set / clear / leave unchanged) back
 * through it. Minimum UI in the Studio design language — no XMP, no
 * custom keys (both unsupported by the engine, by design).
 */
export default function MetadataTool() {
  const { files, setFiles, addFiles } = usePdfFiles();
  const file = files[0] ?? null;
  const [meta, setMeta] = useState<DocumentMetadataData | null>(null);
  const [reading, setReading] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<{ name: string; blob: Blob } | null>(null);
  const [doneMeta, setDoneMeta] = useState<Array<string | null>>([]);
  const [error, setError] = useState<unknown>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<TextKey, string>>({
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: '',
  });
  const [clears, setClears] = useState<Record<string, boolean>>({});
  const [dates, setDates] = useState<Record<DateKey, string>>({
    creationDate: '',
    modificationDate: '',
  });
  const jobRef = useRef<StudioJob | null>(null);

  useEffect(() => {
    setMeta(null);
    setDone(null);
    setDoneMeta([]);
    setError(null);
    if (!file) return;
    let cancelled = false;
    (async () => {
      setReading(true);
      try {
        const job = runStudioOperation('pdf.read_metadata', [file.id], {});
        jobRef.current = job;
        const out = await job.done;
        jobRef.current = null;
        if (cancelled) return;
        const summary = out.summary;
        if (summary && 'metadata' in summary && !('pdfVersion' in summary)) {
          setMeta(summary.metadata);
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setReading(false);
      }
    })();
    return () => {
      cancelled = true;
      void jobRef.current?.cancel();
    };
  }, [file]);

  const onSave = async () => {
    if (!file) return;
    setWorking(true);
    setError(null);
    setDone(null);
    setDoneMeta([]);
    setFraction(null);
    setStage(null);
    try {
      const patch: Record<string, { op: 'set' | 'clear'; value?: unknown }> = {};
      for (const { key } of TEXT_FIELDS) {
        if (clears[key]) {
          patch[key] = { op: 'clear' };
        } else if (texts[key].trim() !== '') {
          patch[key] = { op: 'set', value: texts[key].trim() };
        }
      }
      for (const { key } of DATE_FIELDS) {
        const wireKey = key === 'creationDate' ? 'creation_date' : 'modification_date';
        if (clears[key]) {
          patch[wireKey] = { op: 'clear' };
        } else if (dates[key].trim() !== '') {
          const parsed = parseMetadataDate(dates[key]);
          if (!parsed.ok)
            throw new Error(
              `${key === 'creationDate' ? 'Creation date' : 'Modification date'}: ${parsed.error}`,
            );
          const d = parsed.date;
          patch[wireKey] = {
            op: 'set',
            value: {
              year: d.year,
              month: d.month,
              day: d.day,
              hour: d.hour,
              minute: d.minute,
              second: d.second,
              tz_offset_minutes: d.tzOffsetMinutes,
            },
          };
        }
      }
      const job = runStudioOperation(
        'pdf.set_metadata',
        [file.id],
        { patch },
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
      const name = smartOutputName('metadata', [file.name]);
      setDone({
        name,
        blob: new Blob([first.bytes as unknown as BlobPart], { type: 'application/pdf' }),
      });
      const summary = out.summary;
      setDoneMeta([
        summary !== undefined && 'pageCount' in summary ? `${summary.pageCount} pages` : null,
        `${formatBytes(first.byteLength)}`,
        `Completed in ${formatDurationMs(out.durationMs)}`,
      ]);
      // Refresh the displayed properties from the written output.
      const temp = await openStudioBytes(`reread:${name}`, first.bytes);
      try {
        const reread = await runStudioOperation('pdf.read_metadata', [temp.id], {}).done;
        const summary = reread.summary;
        if (summary && 'metadata' in summary && !('pdfVersion' in summary)) {
          setMeta(summary.metadata);
        }
      } finally {
        await closeStudioDoc(temp.id);
      }
    } catch (e) {
      jobRef.current = null;
      const code = (e as { code?: string }).code;
      if (code === 'CANCELLED') {
        setError(new Error('Metadata save cancelled.'));
      } else {
        setError(e);
      }
    } finally {
      setWorking(false);
      setFraction(null);
      setStage(null);
    }
  };

  const onCancel = async () => {
    try {
      await jobRef.current?.cancel();
    } catch {
      // The job settles the UI via onSave's catch/finally.
    }
  };

  const rows: Array<[string, string]> = meta
    ? [
        ['Title', meta.title ?? '—'],
        ['Author', meta.author ?? '—'],
        ['Subject', meta.subject ?? '—'],
        ['Keywords', meta.keywords ?? '—'],
        ['Creator', meta.creator ?? '—'],
        ['Producer', meta.producer ?? '—'],
        ['Creation date', meta.creationDate === null ? '—' : formatDate(meta.creationDate)],
        [
          'Modification date',
          meta.modificationDate === null ? '—' : formatDate(meta.modificationDate),
        ],
      ]
    : [];

  return (
    <div className="py-6">
      <ToolHeading
        icon={ICON}
        name="Metadata"
        desc="Read and edit document properties — title, author, dates and more."
      />

      {!file && (
        <DropZone
          accept="application/pdf"
          multiple={false}
          onFiles={(f) => addFiles(f)}
          title="Drop a PDF to inspect"
          cta="Select PDF"
        />
      )}

      {file && (
        <div className="space-y-5">
          <FileChip
            name={file.name}
            size={file.sizeBytes}
            onRemove={() => {
              setFiles([]);
              setDone(null);
              setDoneMeta([]);
              setMeta(null);
            }}
          />

          <Card>
            <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-3">
              Current properties
            </p>
            {reading ? (
              <div className="flex items-center gap-2 text-sm text-ink-400">
                <Spinner /> Reading…
              </div>
            ) : meta ? (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                {rows.map(([label, value]) => (
                  <div
                    key={label}
                    className="flex justify-between gap-2 border-b border-paper-200/60 dark:border-ink-800/60 py-1"
                  >
                    <dt className="text-ink-400 dark:text-ink-300 shrink-0">{label}</dt>
                    <dd
                      className="truncate text-right text-ink-900 dark:text-paper-100"
                      title={value}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-ink-400">No metadata yet.</p>
            )}
          </Card>

          <Card>
            <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-1">
              Edit properties
            </p>
            <p className="text-xs text-ink-400 dark:text-ink-300 mb-3">
              Blank means leave unchanged. Dates use{' '}
              <span className="font-mono">YYYY-MM-DD HH:MM:SS +HHMM</span>.
            </p>
            <div className="space-y-2">
              {TEXT_FIELDS.map(({ key, label }) => (
                <div key={key} className="flex items-end gap-2">
                  <div className="flex-1">
                    <label
                      htmlFor={`studio-meta-${key}`}
                      className="mb-1 block text-xs text-ink-400 dark:text-ink-300"
                    >
                      {label}
                    </label>
                    <input
                      id={`studio-meta-${key}`}
                      className="w-full rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-900 px-4 py-2 text-sm text-ink-900 dark:text-paper-100 outline-none focus:border-brass-400"
                      value={texts[key]}
                      onChange={(e) => setTexts((p) => ({ ...p, [key]: e.target.value }))}
                    />
                  </div>
                  <label className="flex shrink-0 items-center gap-1 pb-2 text-xs text-ink-400 dark:text-ink-300">
                    <input
                      type="checkbox"
                      checked={!!clears[key]}
                      onChange={(e) => setClears((p) => ({ ...p, [key]: e.target.checked }))}
                    />
                    Clear
                  </label>
                </div>
              ))}
              {DATE_FIELDS.map(({ key, label }) => (
                <div key={key} className="flex items-end gap-2">
                  <div className="flex-1">
                    <label
                      htmlFor={`studio-meta-${key}`}
                      className="mb-1 block text-xs text-ink-400 dark:text-ink-300"
                    >
                      {label}
                    </label>
                    <input
                      id={`studio-meta-${key}`}
                      className="w-full rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-900 px-4 py-2 text-sm font-mono text-ink-900 dark:text-paper-100 outline-none focus:border-brass-400"
                      value={dates[key]}
                      placeholder="2026-01-23 09:30:00 +0530"
                      onChange={(e) => setDates((p) => ({ ...p, [key]: e.target.value }))}
                    />
                  </div>
                  <label className="flex shrink-0 items-center gap-1 pb-2 text-xs text-ink-400 dark:text-ink-300">
                    <input
                      type="checkbox"
                      checked={!!clears[key]}
                      onChange={(e) => setClears((p) => ({ ...p, [key]: e.target.checked }))}
                    />
                    Clear
                  </label>
                </div>
              ))}
            </div>
          </Card>

          {!done && (
            <div className="flex items-center gap-3">
              <Button onClick={onSave} disabled={working || reading} className="w-full">
                {working ? 'Saving…' : 'Save metadata'}
              </Button>
              {working && (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </div>
          )}
          {working && fraction !== null && (
            <div className="w-full max-w-xs">
              <Progress value={fraction * 100} label={stage ?? 'Working…'} />
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
              <ResultMeta lines={doneMeta} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
