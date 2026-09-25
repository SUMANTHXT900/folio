/**
 * Measured viewport geometry for the scanner (M3.x follow-up).
 *
 * Problem it solves: sizing the viewport from `aspect-ratio` CSS plus
 * viewport-height guesses (`100dvh - 240px`) breaks whenever surrounding
 * chrome changes (session strip appears, review panel opens, topbar
 * wraps) — the box diverges from the real video ratio and the "exact
 * frame" guarantee turns into black bars, with the guide misregistered.
 *
 * Instead the wrapper flexes to whatever space is left, we measure its
 * real pixel box with a ResizeObserver, and compute the largest `contain`
 * rect for the video ratio inside it. The video and the overlay both
 * render exactly that rect: zero letterbox bars by construction, guide
 * always registered to the painted pixels.
 */

import { useEffect, useRef, useState } from 'react';

export interface Box {
  w: number;
  h: number;
}

export interface Rect extends Box {
  x: number;
  y: number;
}

/**
 * Largest rect of `ratio` (w/h) fitting inside `box`, centered.
 * Pure + unit-tested. Degenerate inputs yield a zero rect, never NaN.
 */
export function containRect(box: Box, ratio: number): Rect {
  if (
    !Number.isFinite(box.w) ||
    !Number.isFinite(box.h) ||
    !Number.isFinite(ratio) ||
    box.w <= 0 ||
    box.h <= 0 ||
    ratio <= 0
  ) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const boxRatio = box.w / box.h;
  // Contain: fit by the tighter dimension.
  const w = boxRatio > ratio ? box.h * ratio : box.w;
  const h = boxRatio > ratio ? box.h : box.w / ratio;
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
}

/**
 * Measures `ref`'s content box and returns the contain rect for
 * `ratio`. Recomputes on resize (strip opens, orientation changes).
 */
export function useContainBox<T extends HTMLElement>(
  ratio: number,
): {
  ref: React.RefObject<T | null>;
  rect: Rect | null;
} {
  const ref = useRef<T | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const update = () => {
      const box = el.getBoundingClientRect();
      // Never store a zero box: while hidden (starting state) the element
      // measures 0×0, and persisting that would pin the viewport at zero
      // if the observer ever misses the unhide refire. Null falls back
      // to the aspect-ratio style until a real measurement lands.
      if (box.width <= 0 || box.height <= 0) return;
      setRect(containRect({ w: box.width, h: box.height }, ratio));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ratio]);
  return { ref, rect };
}
