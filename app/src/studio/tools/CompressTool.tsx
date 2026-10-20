import { ToolHeading, DropZone, FileChip, Button, Card } from '../components/ui';
import { usePdfFiles } from '../hooks/usePdfFiles';

const LEVELS = [
  { label: 'Best quality', hint: 'Not available yet.' },
  { label: 'Balanced', hint: 'Not available yet.' },
  {
    label: 'Maximum compression',
    hint: 'Not available yet.',
  },
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

  return (
    <div className="py-6">
      <ToolHeading
        icon={<CompressIcon />}
        name="Compress"
        desc="Reserved for a future update — not available yet."
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
            <p
              id="compress-level-heading"
              className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-1"
            >
              Compression level
            </p>
            {/* Levels are preview-only while Compress is reserved: every
                option is disabled with its reason, so picking one can never
                pretend to change the (non-existent) output. */}
            <p id="compress-level-note" className="text-xs text-ink-500 dark:text-ink-300 mb-3">
              Not available yet — these options do nothing until Compress ships.
            </p>
            <div
              className="grid gap-2"
              role="radiogroup"
              aria-labelledby="compress-level-heading"
              aria-describedby="compress-level-note"
              aria-disabled="true"
            >
              {LEVELS.map((lv) => (
                <button
                  key={lv.label}
                  type="button"
                  disabled
                  title="Not available yet — selection does nothing"
                  aria-describedby="compress-level-note"
                  className="flex items-center justify-between rounded-xl border px-4 py-3 text-left border-paper-300 dark:border-ink-700 opacity-60 cursor-not-allowed"
                >
                  <span>
                    <span className="block text-sm font-medium text-ink-900 dark:text-paper-100">
                      {lv.label}
                    </span>
                    <span className="block text-xs text-ink-400 dark:text-ink-300">{lv.hint}</span>
                  </span>
                  <span className="w-4 h-4 rounded-full border border-paper-300 dark:border-ink-600" />
                </button>
              ))}
            </div>
          </Card>

          <Button disabled className="w-full" onClick={() => undefined}>
            Compress
          </Button>
          <Card>
            <p className="text-sm text-ink-500 dark:text-ink-300">
              Not available yet. This action stays disabled rather than pretending to work.
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
