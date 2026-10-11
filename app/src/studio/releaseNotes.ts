/**
 * User-facing release notes — what changed in each shipped version.
 *
 * Append-only, newest first: add a new entry ABOVE the existing ones when a
 * release ships. Never rewrite or trim old entries, and never list unshipped
 * work here — these notes are evidence, not a roadmap. One-liners for users:
 * no dev-wave internals, no aspirations. The empty-notes fallback is rendered
 * by the consumer, not here.
 */
export interface ReleaseNote {
  /** Release label, e.g. "v1.10.1 release". */
  build: string;
  /** ISO date (YYYY-MM-DD) the release shipped. */
  date: string;
  /** Short, user-facing notes — visible changes only. */
  notes: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    build: 'v1.10.1 release',
    date: '2026-10-05',
    notes: [
      'Scanner detection is now ML-only — a miss keeps your full photo instead of a guessed crop.',
      'The scanner works fully offline after your first open.',
    ],
  },
  {
    build: 'v1.10.0 release',
    date: '2026-10-05',
    notes: [
      'Speed pass: image-tap lag and the capture-button freeze are fixed; same features throughout.',
    ],
  },
  {
    build: 'v1.9.7 release',
    date: '2026-10-05',
    notes: [
      'Fixes the About App-updates flow — checking for and installing updates now works reliably.',
    ],
  },
  {
    build: 'v1.9.6 release',
    date: '2026-10-05',
    notes: ['Internal test speedup only — nothing visible changed.'],
  },
  {
    build: 'v1.9.5 release',
    date: '2026-10-04',
    notes: [
      'New on-device document scanner: point, capture, adjust, build a PDF — fully offline.',
      'Auto-accept review with adjustable crop, calm loupe, and fullscreen finder.',
      'Warped pages save as full-resolution JPEG; your originals stay untouched.',
    ],
  },
];
