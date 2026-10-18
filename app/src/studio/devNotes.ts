/**
 * Dev-channel notes — what shipped in the build you are looking at.
 *
 * Append-only, newest first: add a new entry ABOVE the existing ones when a
 * wave lands. Never rewrite or trim old entries, and never list unshipped
 * work here — these notes are evidence, not a roadmap. Rendered only on
 * non-production hosts by the D36 dev-channel card in About.tsx.
 */
export interface DevNote {
  /** Wave label, e.g. "D35/D36 scanner UX". */
  build: string;
  /** ISO date (YYYY-MM-DD) the wave landed. */
  date: string;
  /** Short, factual notes — shipped behavior only. */
  notes: string[];
}

export const DEV_NOTES: DevNote[] = [
  {
    build: 'D54 PWA installability',
    date: '2026-10-18',
    notes: [
      'Proper install icons (192/512, maskable, Apple touch) plus real-app screenshots in the manifest.',
      'About gains an Install app card; Home shows a dismissible install banner only when installation is possible.',
      'iPhones get Share-to-Home-Screen steps; installed apps see proof copy instead of a button.',
    ],
  },
  {
    build: 'D53 shutter-instant hardening',
    date: '2026-10-18',
    notes: [
      'The shutter answers instantly: a Capturing note shows on tap and the button waits for the shot instead of stacking taps.',
      'Camera capabilities resolve once per camera, not once per tap.',
      'The sharper-camera suggestion arrives past the first taps and never interrupts shooting.',
    ],
  },
  {
    build: 'D52 minimal scanner redo',
    date: '2026-10-11',
    notes: [
      'Camera is finder plus shutter plus count: flash, flip, mirror, camera pick, and capture mode live in one More sheet.',
      'Status pill speaks only when actionable; the strip is a slim count bar with a reserved slot.',
      'Review keeps the single-canvas hero with a minimal pager, slim filmstrip, and Next plus Discard bar.',
    ],
  },
  {
    build: 'D51 ML + viewfinder phase 1',
    date: '2026-10-11',
    notes: [
      'ML core: retained warm detect client across drains, K lanes from pending count, per-item timing spans plus confidence and read-only EXIF probe.',
      'Session level already optimal (verified in vendored bytes) — no threading or provider change.',
      'Viewfinder refactor: one top-bar chrome, quiet finder pill, gallery count badge, non-blocking review, safe-area and reduced-motion guards.',
    ],
  },
  {
    build: 'v1.10.3 split sharpness',
    date: '2026-10-11',
    notes: [
      'Split pick grid renders at a grid tier (192px base × DPR) instead of the small list tier.',
      'Split preview borrows the full-res render with the grid thumb as fallback; tile images load eagerly.',
    ],
  },
  {
    build: 'v1.10.2 update simplification',
    date: '2026-10-11',
    notes: [
      'Update flow is one button: tap Update to check, a found build applies with a hard reload — no popups, no confirm step.',
      'Every app launch checks silently and applies the same way; the About card shows version plus build time on every host.',
    ],
  },
  {
    build: 'D48 continue-flow handoff',
    date: '2026-10-11',
    notes: [
      'Post-completion fork: Use-in-another-tool picker vs Download branch behind a toggle.',
      'By-reference single-slot handoff (PendingTransfer); Images is source-only, never a target.',
      'Split offers per-part plus all-as-merge; source names stay verbatim.',
    ],
  },
  {
    build: 'D47 deferred review-time detection',
    date: '2026-10-06',
    notes: [
      'Shutter is queue-only: instant capture with no decode or ML per tap, finder stays idle.',
      'ML drains deferred at review entry over K parallel lanes behind a blocking Preparing overlay with Cancel.',
      'A miss still keeps the full frame; eager warp waits for ready.',
    ],
  },
  {
    build: 'v1.10.1 release',
    date: '2026-10-05',
    notes: [
      'Detection is ML-only: a miss keeps the full frame, never a guessed crop.',
      'ML assets back in the PWA precache; offline-first after first open.',
      'Classical stays on the wire and type but never runs.',
    ],
  },
  {
    build: 'v1.10.0 release',
    date: '2026-10-05',
    notes: [
      'Interaction-performance pass; no behavior changes, engine contract untouched.',
      'Images: 256px JPEG thumbs at import, modal keyed by page id, rotate via the encode worker.',
      'Scan: detection plus warp on the ScanicClient worker, single warp per Apply with cancel-supersede.',
      'PDF tools close docs on remove (leak fix) with tiered thumbs; engine shares extract tables in place.',
    ],
  },
  {
    build: 'v1.9.7 release',
    date: '2026-10-05',
    notes: [
      'About App-updates repair: prompt registration with user-gated activation.',
      'Bounded 15s update check; missing registration is an error, failed activation retries.',
      'Offline stays checkable with resurface on return; suite 462/462.',
    ],
  },
  {
    build: 'v1.9.6 release',
    date: '2026-10-05',
    notes: [
      'Test-only wave, no shipped code.',
      '14 pure-logic test files run under node instead of jsdom.',
      'Suite 448/448; wall time about 270s down to about 206s.',
    ],
  },
  {
    build: 'v1.9.5 release',
    date: '2026-10-04',
    notes: ['Scanic ML scanner to production.', 'Main-lens default + JPEG warp.', 'Version 1.9.5.'],
  },
  {
    build: 'D45 main-lens + JPEG warp',
    date: '2026-10-04',
    notes: ['Main-lens default scoring.', 'JPEG warped output.', 'Calmer 0.6x loupe.'],
  },
  {
    build: 'D44 best-camera + flash honesty',
    date: '2026-10-04',
    notes: [
      'Best-camera suggestion + persisted pick.',
      'Flash stays visible with honest note.',
      'Calmer 1.1x loupe.',
      '12-hour clock everywhere.',
    ],
  },
  {
    build: 'D35/D36 scanner UX',
    date: '2026-10-04',
    notes: [
      'Scanner opens as a full-screen takeover with body scroll-lock instead of an in-page panel.',
      'ML document detection only — a miss keeps the full frame, never a guessed crop (D46: classical removed).',
      'Review keeps the detection overlay for crop-adjust — Apply and Re-detect refresh it in place.',
      'Warped page previews are reactive: a re-warp swaps the image instead of leaving a stale one.',
    ],
  },
];
