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
    build: 'v1.12.2 release',
    date: '2026-10-18',
    notes: [
      'You can install Folio on your phone now — look for the install banner or the Install app card in About.',
    ],
  },
  {
    build: 'v1.12.1 release',
    date: '2026-10-18',
    notes: ['The scanner shutter answers instantly now — no more freeze when you tap to capture.'],
  },
  {
    build: 'v1.12.0 release',
    date: '2026-10-11',
    notes: [
      'The scanner is decluttered — a clean viewfinder with one shutter button, extras tucked into a More menu.',
    ],
  },
  {
    build: 'v1.11.0 release',
    date: '2026-10-11',
    notes: [
      'The scanner looks cleaner and stays out of your way — simpler top bar, quiet guidance, and you can keep browsing pages while it prepares them.',
      'Faster repeat scans: the detector stays warm between pages.',
    ],
  },
  {
    build: 'v1.10.3 release',
    date: '2026-10-11',
    notes: [
      'Split page thumbnails and previews are sharp now — no more blurry pages when picking.',
    ],
  },
  {
    build: 'v1.10.2 release',
    date: '2026-10-11',
    notes: [
      'App updates are now one button in About — tap it to get the latest version, and the app updates itself on every open.',
    ],
  },
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
