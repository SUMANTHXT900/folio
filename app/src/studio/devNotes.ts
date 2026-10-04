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
    build: 'D35/D36 scanner UX',
    date: '2026-10-04',
    notes: [
      'Scanner opens as a full-screen takeover with body scroll-lock instead of an in-page panel.',
      'ML document detection is the default; when it finds nothing, classical detection silently takes over.',
      'Review keeps the detection overlay for crop-adjust — Apply and Re-detect refresh it in place.',
      'Warped page previews are reactive: a re-warp swaps the image instead of leaving a stale one.',
    ],
  },
];
