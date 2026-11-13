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
    build: 'v1.12.8 scanner repair',
    date: '2026-11-13',
    notes: [
      'The scanner saves the full camera frame instead of cutting it to your screen shape, with less JPEG compression for captured and cropped pages.',
      'Zoom out to Wide, adjust supported zoom and brightness, or request autofocus from compact camera controls.',
      'Refresh the camera list, or choose Use phone camera for a native photo. Some phone lenses cannot be accessed directly by browsers.',
    ],
  },
  {
    build: 'v1.12.7 portrait camera experience',
    date: '2026-11-12',
    notes: [
      'Portrait viewfinder fills the screen and captures the same visible framing. Double-tap refocus and sun brightness controls are accessible directly over the preview where supported.',
    ],
  },
  {
    build: 'v1.12.6 camera framing and controls',
    date: '2026-11-12',
    notes: [
      'Scanner preview shows the full camera frame without cropping. Camera zoom resets to its supported 1 setting on startup. Brightness adjustment and refocus are available when supported by the selected camera.',
    ],
  },
  {
    build: 'v1.12.5 development update',
    date: '2026-11-12',
    notes: [
      'Camera capture now uses the live video frame. PDF intake errors are visible in Merge, Rotate and Metadata; image previews support Escape and keyboard focus.',
    ],
  },
  {
    build: 'v1.12.4 release',
    date: '2026-10-20',
    notes: [
      'The scanner review opens instantly and has one Build PDF action: pages are added and the PDF starts building without a second tap.',
      'Auto-crop settles before Build is enabled, so a build no longer silently uses an uncropped photo.',
      'If adding pages fails, your scans stay in review so you can retry instead of losing the queue.',
    ],
  },
  {
    build: 'v1.12.3 release',
    date: '2026-10-20',
    notes: [
      'A reliability pass: steadier cancel, clearer errors, keyboard-friendly tools, and more honest progress and download messages.',
    ],
  },
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
