import { useState } from 'react';
import { ToolHeading, DropZone, FileChip, Button, Card } from '../components/ui';
import { usePdfFiles } from '../hooks/usePdfFiles';

const LEVELS = [
  { label: 'Best quality', hint: 'Minimal size reduction, crisp output' },
  { label: 'Balanced', hint: 'Good balance of size and clarity' },
  { label: 'Maximum compression', hint: 'Smallest file, lower fidelity' },
] as const;

/**
 * Compress tool (Phase 2 placeholder — §37).
 *
 * The file picker and level selector are fully functional Studio UI,
 * but PDF compression/optimization belongs to a future phase: there is
 * deliberately no backend wired to the action. The button stays
 * disabled with an explicit future-functionality note rather than a
 * fake implementation.
 */
export default function CompressTool() {
  const { files, setFiles, addFiles } = usePdfFiles();
  const file = files[0] ?? null;
  const [level, setLevel] = useState<number>(1);

  return (
    <div className="py-6">
      <ToolHeading
        icon={<CompressIcon />}
        name="Compress"
        desc="Shrink file size by re-rendering pages"
      />

      {!file && (
        <DropZone
          accept="application/pdf"
          multiple={false}
          onFiles={(f) => addFiles(f)}
          title="Drop a PDF to compress"
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
            }}
          />

          <Card>
            <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-3">
              Compression level
            </p>
            <div className="grid gap-2">
              {LEVELS.map((lv, i) => (
                <button
                  key={lv.label}
                  onClick={() => setLevel(i)}
                  className={
                    'flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ' +
                    (level === i
                      ? 'border-brass-400 bg-brass-400/10'
                      : 'border-paper-300 dark:border-ink-700 hover:border-brass-400/60')
                  }
                >
                  <span>
                    <span className="block text-sm font-medium text-ink-900 dark:text-paper-100">
                      {lv.label}
                    </span>
                    <span className="block text-xs text-ink-400 dark:text-ink-300">{lv.hint}</span>
                  </span>
                  <span
                    className={
                      'w-4 h-4 rounded-full border ' +
                      (level === i
                        ? 'border-brass-500 bg-brass-500'
                        : 'border-paper-300 dark:border-ink-600')
                    }
                  />
                </button>
              ))}
            </div>
          </Card>

          <Button disabled className="w-full" onClick={() => undefined}>
            Compress
          </Button>
          <Card>
            <p className="text-sm text-ink-500 dark:text-ink-300">
              Compression is coming in a future update — the engine does not implement it yet, so
              this action stays disabled rather than pretending to work.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

function CompressIcon() {
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
      <path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M8 3l6 6m0 0V3H8m0 0v6h6" />
    </svg>
  );
}
