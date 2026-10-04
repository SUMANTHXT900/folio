/**
 * ScanicReview tests: single-canvas result view, adjust-only quad overlay
 * with 8 handles (4 corners + 4 rigid-edge midpoints), adjust-mode
 * drag/keyboard editing, Apply/Re-detect emissions, Reset gating,
 * use-original verdict chip, and the reactive result image.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScanicReview, {
  loupePosition,
  loupeSourceRect,
  LOUPE_SIZE,
  LOUPE_ZOOM,
} from './ScanicReview';
import type { ScanicReviewProps } from './ScanicReview';
import type { ScanicCorners } from './scan/index';

afterEach(cleanup);

const W = 100;
const H = 100;

function detectedCorners(): ScanicCorners {
  return {
    topLeft: { x: 10, y: 10 },
    topRight: { x: 90, y: 10 },
    bottomRight: { x: 90, y: 90 },
    bottomLeft: { x: 10, y: 90 },
  };
}

function baseProps(overrides: Partial<ScanicReviewProps> = {}): ScanicReviewProps {
  return {
    photoUrl: 'photo.jpg',
    imageWidth: W,
    imageHeight: H,
    corners: detectedCorners(),
    warpedUrl: 'warped.jpg' as string | null,
    detecting: false,
    note: null as string | null,
    pageLabel: 'Page 1 of 2',
    progressLabel: '0 of 2 reviewed',
    verdict: 'warped',
    onAdjustApply: vi.fn(),
    onUseOriginal: vi.fn(),
    onDiscard: vi.fn(),
    onRedetect: vi.fn(),
    redetecting: false,
    ...overrides,
  };
}

function enterAdjust() {
  fireEvent.click(screen.getByRole('button', { name: 'Adjust corners' }));
}

function mockAdjustRect(container: HTMLElement) {
  const adjust = container.querySelector('[data-crop-adjust]') as HTMLElement | null;
  if (!adjust) throw new Error('missing [data-crop-adjust]');
  adjust.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 }) as DOMRect;
  return adjust;
}

describe('ScanicReview', () => {
  it('shows ONLY the warped canvas in the single-canvas result view', () => {
    const { container, rerender } = render(<ScanicReview {...baseProps()} />);
    const result = container.querySelector('[data-crop-result]');
    expect(result).not.toBeNull();
    // Exactly one image: the warped canvas. No overlay, no second canvas.
    expect(result?.querySelectorAll('img').length).toBe(1);
    const img = container.querySelector('[data-crop-result-img]');
    expect(img?.getAttribute('src')).toBe('warped.jpg');
    expect(container.querySelector('[data-detect-overlay]')).toBeNull();
    expect(result?.querySelector('polygon')).toBeNull();

    // Reactive src: a fresh warp swaps the single canvas.
    rerender(<ScanicReview {...baseProps({ warpedUrl: 'warped-2.jpg' })} />);
    const result2 = container.querySelector('[data-crop-result]');
    expect(result2?.querySelectorAll('img').length).toBe(1);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'warped-2.jpg',
    );
    expect(container.querySelector('[data-detect-overlay]')).toBeNull();
  });

  it('shows the ML-found quad only inside adjust mode, seeded from prop corners', () => {
    const { container, rerender } = render(<ScanicReview {...baseProps()} />);
    expect(container.querySelector('[data-crop-adjust]')).toBeNull();
    expect(container.querySelector('[data-crop-result] polygon')).toBeNull();

    enterAdjust();
    const adjust = container.querySelector('[data-crop-adjust]');
    expect(adjust).not.toBeNull();
    expect(adjust?.querySelector('polygon')?.getAttribute('points')).toBe(
      '10,10 90,10 90,90 10,90',
    );

    // Leaving adjust mode hides the outline again; re-entering seeds fresh
    // corners from the prop (post-Apply / post-Re-detect values).
    const tl = document.querySelector('[data-crop-handle="tl"]') as HTMLElement;
    fireEvent.keyDown(tl, { key: 'Escape' });
    expect(container.querySelector('[data-crop-adjust]')).toBeNull();
    expect(container.querySelector('[data-crop-result] polygon')).toBeNull();

    const next = detectedCorners();
    next.topLeft = { x: 20, y: 25 };
    rerender(<ScanicReview {...baseProps({ corners: next })} />);
    expect(container.querySelector('[data-crop-adjust]')).toBeNull();
    enterAdjust();
    expect(container.querySelector('[data-crop-adjust] polygon')?.getAttribute('points')).toBe(
      '20,25 90,10 90,90 10,90',
    );
  });

  it('renders 8 handles in adjust mode: 4 corners + 4 rigid-edge midpoints', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    const adjust = container.querySelector('[data-crop-adjust]');
    expect(adjust).not.toBeNull();
    expect(adjust?.querySelectorAll('[data-crop-handle]').length).toBe(4);
    expect(adjust?.querySelectorAll('[data-crop-handle-mid]').length).toBe(4);
    for (const key of ['tl', 'tr', 'br', 'bl']) {
      const h = document.querySelector(`[data-crop-handle="${key}"]`);
      expect(h?.getAttribute('role')).toBe('slider');
    }
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(document.querySelector(`[data-crop-handle-mid="${edge}"]`)).not.toBeNull();
    }
    // 44px targets on every handle.
    for (const h of Array.from(
      adjust?.querySelectorAll('[data-crop-handle], [data-crop-handle-mid]') ?? [],
    )) {
      expect((h as HTMLElement).className).toMatch('min-h-[44px]');
      expect((h as HTMLElement).className).toMatch('min-w-[44px]');
    }
  });

  it('midpoint drag moves BOTH adjacent corners by one equal delta, never shearing', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    mockAdjustRect(container);
    const midTop = document.querySelector('[data-crop-handle-mid="top"]') as HTMLElement;
    // Mid-top starts at (50,10); drag by (+10,+10).
    fireEvent.pointerDown(midTop, { clientX: 50, clientY: 10, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(midTop, { clientX: 60, clientY: 20, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(midTop, { pointerId: 1 });
    const points = container.querySelector('[data-crop-adjust] polygon')?.getAttribute('points');
    // Both top corners shifted by exactly (+10,+10); bottom edge untouched.
    expect(points).toBe('20,20 100,20 90,90 10,90');
    const nums = points!.split(/[ ,]+/).map(Number);
    const [tlx, tly, trx, try_, brx, bry, blx, bly] = nums;
    expect(trx - tlx).toBe(80);
    expect(try_ - tly).toBe(0);
    expect(brx).toBe(90);
    expect(bry).toBe(90);
    expect(blx).toBe(10);
    expect(bly).toBe(90);
  });

  it('midpoint drag clamps the delta so both corners stay in bounds', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    mockAdjustRect(container);
    const midTop = document.querySelector('[data-crop-handle-mid="top"]') as HTMLElement;
    // Far outside: delta (+150,+190) clamps to (+10,+90) for the top edge.
    fireEvent.pointerDown(midTop, { clientX: 50, clientY: 10, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(midTop, { clientX: 200, clientY: 200, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(midTop, { pointerId: 1 });
    expect(container.querySelector('[data-crop-adjust] polygon')?.getAttribute('points')).toBe(
      '20,100 100,100 90,90 10,90',
    );
  });

  it('midpoint drag is convexity-guarded: a collapsing move is rejected', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    mockAdjustRect(container);
    const midTop = document.querySelector('[data-crop-handle-mid="top"]') as HTMLElement;
    // Drag the top edge exactly onto the bottom edge (area zero) — rejected.
    fireEvent.pointerDown(midTop, { clientX: 50, clientY: 10, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(midTop, { clientX: 50, clientY: 90, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(midTop, { pointerId: 1 });
    expect(container.querySelector('[data-crop-adjust] polygon')?.getAttribute('points')).toBe(
      '10,10 90,10 90,90 10,90',
    );
  });

  it('midpoint keyboard nudge translates the whole edge rigidly', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    const midLeft = document.querySelector('[data-crop-handle-mid="left"]') as HTMLElement;
    fireEvent.keyDown(midLeft, { key: 'ArrowRight' });
    expect(container.querySelector('[data-crop-adjust] polygon')?.getAttribute('points')).toBe(
      '11,10 90,10 90,90 11,90',
    );
    fireEvent.keyDown(midLeft, { key: 'ArrowRight', shiftKey: true });
    expect(container.querySelector('[data-crop-adjust] polygon')?.getAttribute('points')).toBe(
      '21,10 90,10 90,90 21,90',
    );
  });

  it('Apply after a midpoint drag emits the 8-point quad as 4 corners', () => {
    const props = baseProps();
    const { container } = render(<ScanicReview {...props} />);
    enterAdjust();
    mockAdjustRect(container);
    const midTop = document.querySelector('[data-crop-handle-mid="top"]') as HTMLElement;
    fireEvent.pointerDown(midTop, { clientX: 50, clientY: 10, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(midTop, { clientX: 60, clientY: 20, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(midTop, { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onAdjustApply).toHaveBeenCalledTimes(1);
    const emitted = vi.mocked(props.onAdjustApply).mock.calls[0][0];
    expect(emitted.topLeft).toEqual({ x: 20, y: 20 });
    expect(emitted.topRight).toEqual({ x: 100, y: 20 });
    expect(emitted.bottomRight).toEqual({ x: 90, y: 90 });
    expect(emitted.bottomLeft).toEqual({ x: 10, y: 90 });
    // Midpoints are derived, never stored: exactly the 4 corner keys.
    expect(Object.keys(emitted).sort()).toEqual(
      ['bottomLeft', 'bottomRight', 'topLeft', 'topRight'].sort(),
    );
  });

  it('shows an honest no-detection caption when corners are null (single canvas)', () => {
    const { container, rerender } = render(<ScanicReview {...baseProps({ corners: null })} />);
    const result = container.querySelector('[data-crop-result]');
    expect(result?.querySelector('polygon')).toBeNull();
    // Warped canvas still single, with the honest caption beneath it.
    expect(result?.querySelectorAll('img').length).toBe(1);
    expect(screen.getByText('Auto-detect found no page — adjust to crop manually.')).toBeTruthy();
    // No warp at all: the ORIGINAL photo is the single canvas (a review with
    // no image is a dead end), captioned honestly — never an empty box.
    rerender(<ScanicReview {...baseProps({ corners: null, warpedUrl: null })} />);
    const result2 = container.querySelector('[data-crop-result]');
    expect(result2?.querySelectorAll('img').length).toBe(1);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'photo.jpg',
    );
    expect(screen.getByText('Auto-detect found no page — adjust to crop manually.')).toBeTruthy();
  });

  it('shows a Processing skeleton when corners exist but no warp yet — never the bare photo', () => {
    const { container } = render(<ScanicReview {...baseProps({ warpedUrl: null })} />);
    const result = container.querySelector('[data-crop-result]');
    expect(result?.querySelectorAll('img').length).toBe(0);
    expect(screen.getByText('Processing auto-crop…')).toBeTruthy();
    expect(container.querySelector('[data-detect-overlay]')).toBeNull();
  });

  it('Use original swaps the single canvas to the unprocessed photo with an honest chip', () => {
    const props = baseProps();
    const { container, rerender } = render(<ScanicReview {...props} />);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'warped.jpg',
    );
    // The verdict lives in the parent: the click reports, the parent flips
    // `verdict`, the hero follows. Toggle-back cannot desync (no local copy).
    fireEvent.click(screen.getByRole('button', { name: 'Use original' }));
    expect(props.onUseOriginal).toHaveBeenCalledTimes(1);
    rerender(<ScanicReview {...props} verdict="original" />);
    const result = container.querySelector('[data-crop-result]');
    expect(result?.querySelectorAll('img').length).toBe(1);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'photo.jpg',
    );
    expect(screen.getByText('Original photo — unprocessed')).toBeTruthy();
    expect(result?.querySelector('polygon')).toBeNull();
    rerender(<ScanicReview {...props} verdict="warped" />);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'warped.jpg',
    );
    expect(screen.queryByText('Original photo — unprocessed')).toBeNull();
  });

  it('shows a Preparing skeleton while detecting', () => {
    const { container } = render(<ScanicReview {...baseProps({ detecting: true })} />);
    const result = container.querySelector('[data-crop-result]');
    expect(result?.textContent).toContain('Preparing…');
    expect(result?.querySelectorAll('img').length).toBe(0);
  });

  it('reactively swaps the single canvas src when a fresh warp lands', () => {
    const { container, rerender } = render(<ScanicReview {...baseProps()} />);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'warped.jpg',
    );
    rerender(<ScanicReview {...baseProps({ warpedUrl: 'warped-2.jpg' })} />);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'warped-2.jpg',
    );
    // Losing the warp falls back to the skeleton — still never a bare photo.
    rerender(<ScanicReview {...baseProps({ warpedUrl: null })} />);
    expect(container.querySelector('[data-crop-result]')?.querySelectorAll('img').length).toBe(0);
    expect(screen.getByText('Processing auto-crop…')).toBeTruthy();
  });

  it('exposes review progress with the progressLabel aria-label', () => {
    render(<ScanicReview {...baseProps()} />);
    const progress = document.querySelector('[data-review-progress]');
    expect(progress?.getAttribute('aria-label')).toBe('0 of 2 reviewed');
    expect(progress?.textContent).toBe('0 of 2 reviewed');
  });

  it('moves a handle with arrow keys and reports the delta via aria-valuenow', () => {
    render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    const tl = document.querySelector('[data-crop-handle="tl"]');
    expect(tl?.getAttribute('role')).toBe('slider');
    expect(tl?.getAttribute('aria-valuenow')).toBe('10');
    fireEvent.keyDown(tl!, { key: 'ArrowRight' });
    expect(tl?.getAttribute('aria-valuenow')).toBe('11');
    fireEvent.keyDown(tl!, { key: 'ArrowRight', shiftKey: true });
    expect(tl?.getAttribute('aria-valuenow')).toBe('21');
  });

  it('Apply emits the dragged corner quad', () => {
    const props = baseProps();
    const { container } = render(<ScanicReview {...props} />);
    enterAdjust();
    mockAdjustRect(container);
    const tl = document.querySelector('[data-crop-handle="tl"]') as HTMLElement;
    fireEvent.pointerDown(tl, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(tl, { clientX: 20, clientY: 30, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(tl, { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onAdjustApply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onAdjustApply).mock.calls[0][0].topLeft).toEqual({ x: 20, y: 30 });
  });

  it('Reset to auto reseeds from the corners prop and is disabled when corners are null', () => {
    const { rerender } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    const reset = screen.getByRole('button', { name: 'Reset to auto' });
    expect(reset.hasAttribute('disabled')).toBe(false);
    const tl = document.querySelector('[data-crop-handle="tl"]') as HTMLElement;
    fireEvent.keyDown(tl, { key: 'ArrowRight' });
    expect(tl.getAttribute('aria-valuenow')).toBe('11');
    fireEvent.click(reset);
    expect(tl.getAttribute('aria-valuenow')).toBe('10');

    rerender(<ScanicReview {...baseProps({ corners: null, photoUrl: 'photo-2.jpg' })} />);
    enterAdjust();
    expect(screen.getByRole('button', { name: 'Reset to auto' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('Re-detect calls the prop and disables while redetecting', () => {
    const props = baseProps();
    const { rerender } = render(<ScanicReview {...props} />);
    const redetect = document.querySelector('[data-redetect]');
    expect(redetect?.textContent).toBe('Re-detect');
    fireEvent.click(redetect!);
    expect(props.onRedetect).toHaveBeenCalledTimes(1);
    rerender(<ScanicReview {...baseProps({ redetecting: true })} />);
    expect(document.querySelector('[data-redetect]')?.hasAttribute('disabled')).toBe(true);
  });

  it('wires the remaining verdict buttons to their callbacks (no Looks-good button)', () => {
    const props = baseProps();
    const { container } = render(<ScanicReview {...props} />);
    // Parent auto-accepts: the review card offers no Looks-good button.
    expect(screen.queryByRole('button', { name: 'Looks good' })).toBeNull();
    expect(container.textContent).not.toContain('Looks good');
    fireEvent.click(screen.getByRole('button', { name: 'Use original' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(props.onUseOriginal).toHaveBeenCalledTimes(1);
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('stays Looks-good-free inside adjust mode too (Apply is the only primary)', () => {
    render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    expect(screen.queryByRole('button', { name: 'Looks good' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });

  it('action bar uses compact icon buttons with sr-only labels (textContent byte-identical)', () => {
    render(<ScanicReview {...baseProps()} />);
    for (const label of ['Adjust corners', 'Re-detect', 'Use original', 'Discard']) {
      const btn = screen.getByRole('button', { name: label });
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.textContent).toBe(label);
      const sr = btn.querySelector('span.sr-only');
      expect(sr).not.toBeNull();
      expect(sr?.textContent).toBe(label);
      expect(btn.querySelector('svg')).not.toBeNull();
      expect(btn.getAttribute('aria-label')).toBe(label);
    }
    // No Looks-good primary: parent auto-accepts.
    expect(screen.queryByRole('button', { name: 'Looks good' })).toBeNull();
  });

  it('positions the overlay strictly inside the object-contain content box (no bar overlap)', () => {
    const { container } = render(
      <ScanicReview {...baseProps({ imageWidth: 100, imageHeight: 100 })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Adjust corners' }));
    const adjust = container.querySelector('[data-crop-adjust]') as HTMLElement;
    // Letterboxed frame: wide container, square photo → side bars.
    adjust.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        right: 200,
        bottom: 100,
        x: 0,
        y: 0,
      }) as DOMRect;
    fireEvent(window, new Event('resize'));
    const svg = container.querySelector('[data-crop-adjust] svg') as unknown as HTMLElement;
    // Contain math: frame 200x100, natural 100x100 → content 100x100 at left 50.
    expect(svg.style.left).toBe('50px');
    expect(svg.style.top).toBe('0px');
    expect(svg.style.width).toBe('100px');
    expect(svg.style.height).toBe('100px');
    // Corner handles sit strictly inside the content rect, never on the bars.
    for (const key of ['tl', 'tr', 'br', 'bl']) {
      const h = document.querySelector(`[data-crop-handle="${key}"]`) as HTMLElement;
      const left = parseFloat(h.style.left);
      const top = parseFloat(h.style.top);
      expect(left).toBeGreaterThanOrEqual(50);
      expect(left).toBeLessThanOrEqual(150);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(100);
    }
  });

  it('maps pointer drag through the same content rect (letterboxed frame)', () => {
    const { container } = render(
      <ScanicReview {...baseProps({ imageWidth: 100, imageHeight: 100 })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Adjust corners' }));
    const adjust = container.querySelector('[data-crop-adjust]') as HTMLElement;
    adjust.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        right: 200,
        bottom: 100,
        x: 0,
        y: 0,
      }) as DOMRect;
    fireEvent(window, new Event('resize'));
    const tl = document.querySelector('[data-crop-handle="tl"]') as HTMLElement;
    // TL at image (10,10) displays at frame (60,10): content left 50 + 10.
    fireEvent.pointerDown(tl, { clientX: 60, clientY: 10, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(tl, { clientX: 70, clientY: 20, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(tl, { pointerId: 1 });
    expect(container.querySelector('[data-crop-adjust] polygon')?.getAttribute('points')).toBe(
      '20,20 90,10 90,90 10,90',
    );
  });

  it('scales handle visuals with display size while hit targets stay 44px', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust corners' }));
    const adjust = container.querySelector('[data-crop-adjust]') as HTMLElement;
    adjust.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
      }) as DOMRect;
    fireEvent(window, new Event('resize'));
    const smallDot = document.querySelector(
      '[data-crop-handle="tl"] > span',
    ) as unknown as HTMLElement;
    const smallSize = parseFloat(smallDot.style.width);
    expect(smallSize).toBe(14);
    adjust.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 400,
        height: 400,
        right: 400,
        bottom: 400,
        x: 0,
        y: 0,
      }) as DOMRect;
    fireEvent(window, new Event('resize'));
    const largeDot = document.querySelector(
      '[data-crop-handle="tl"] > span',
    ) as unknown as HTMLElement;
    const largeSize = parseFloat(largeDot.style.width);
    expect(largeSize).toBe(16);
    expect(largeSize).toBeGreaterThan(smallSize);
    expect(largeSize).toBeLessThanOrEqual(16);
    for (const h of Array.from(
      container.querySelectorAll('[data-crop-handle], [data-crop-handle-mid]') ?? [],
    )) {
      expect((h as HTMLElement).className).toMatch('min-h-[44px]');
      expect((h as HTMLElement).className).toMatch('min-w-[44px]');
    }
  });
});

describe('ScanicReview handles + loupe', () => {
  it('handles use thin solid brass-ring small circles with a center micro-dot (44px hit preserved)', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    // Single-line outline: thin solid 1.5–2px brass, never dotted.
    const outline = container.querySelector(
      '[data-crop-adjust] polygon',
    ) as unknown as SVGPolygonElement | null;
    expect(outline).not.toBeNull();
    const strokeWidth = parseFloat(outline!.getAttribute('stroke-width') ?? '');
    expect(strokeWidth).toBeGreaterThanOrEqual(1.5);
    expect(strokeWidth).toBeLessThanOrEqual(2);
    expect(outline!.getAttribute('stroke-dasharray')).toBeNull();
    for (const key of ['tl', 'tr', 'br', 'bl']) {
      const h = document.querySelector(`[data-crop-handle="${key}"]`) as HTMLElement;
      expect(h.getAttribute('role')).toBe('slider');
      // 44px invisible hit target preserved on the button.
      expect(h.className).toMatch('min-h-[44px]');
      expect(h.className).toMatch('min-w-[44px]');
      expect(h.className).toMatch('h-11');
      expect(h.className).toMatch('w-11');
      const visual = h.querySelector(':scope > span') as HTMLElement | null;
      expect(visual).not.toBeNull();
      // Thin solid small-circle ring (never dotted, never square).
      expect(visual!.className).not.toMatch('border-dotted');
      expect(visual!.className).toMatch('border-solid');
      expect(visual!.className).toMatch('border-brass-400');
      expect(visual!.className).toMatch('rounded-full');
      const size = parseFloat(visual!.style.width);
      expect(size).toBeLessThanOrEqual(16);
      expect(size).toBeGreaterThanOrEqual(14);
      // 2–3px center micro-dot.
      const dot = visual!.querySelector('span') as HTMLElement | null;
      expect(dot).not.toBeNull();
      expect(dot!.className).toMatch('bg-brass-400');
      const dotSize = parseFloat(dot!.style.width);
      expect(dotSize).toBeGreaterThanOrEqual(2);
      expect(dotSize).toBeLessThanOrEqual(3);
    }
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      const h = document.querySelector(`[data-crop-handle-mid="${edge}"]`) as HTMLElement;
      expect(h.getAttribute('role')).toBe('slider');
      expect(h.className).toMatch('min-h-[44px]');
      expect(h.className).toMatch('min-w-[44px]');
      const visual = h.querySelector(':scope > span') as HTMLElement | null;
      expect(visual).not.toBeNull();
      expect(visual!.className).not.toMatch('border-dotted');
      expect(visual!.className).toMatch('border-solid');
      expect(visual!.className).toMatch('border-brass-400');
      expect(visual!.className).toMatch('rounded-full');
      const size = parseFloat(visual!.style.width);
      expect(size).toBeLessThanOrEqual(16);
    }
    expect(container.querySelector('[data-loupe]')).toBeNull();
  });

  it('handle visuals stay in the compact 14–16px range (44px hit preserved)', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    mockAdjustRect(container);
    for (const sel of ['[data-crop-handle="tl"] > span', '[data-crop-handle-mid="top"] > span']) {
      const visual = document.querySelector(sel) as unknown as HTMLElement;
      const size = parseFloat(visual.style.width);
      expect(size).toBeGreaterThanOrEqual(14);
      expect(size).toBeLessThanOrEqual(16);
      expect(parseFloat(visual.style.height)).toBe(size);
    }
    for (const h of Array.from(
      container.querySelectorAll('[data-crop-handle], [data-crop-handle-mid]') ?? [],
    )) {
      expect((h as HTMLElement).className).toMatch('min-h-[44px]');
      expect((h as HTMLElement).className).toMatch('min-w-[44px]');
    }
  });

  it('loupe appears on handle pointerdown with crosshair and hides on pointerup', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    mockAdjustRect(container);
    expect(container.querySelector('[data-loupe]')).toBeNull();
    const tl = document.querySelector('[data-crop-handle="tl"]') as HTMLElement;
    fireEvent.pointerDown(tl, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 });
    const loupe = container.querySelector('[data-loupe]');
    expect(loupe).not.toBeNull();
    expect(loupe?.querySelector('[data-loupe-crosshair]')).not.toBeNull();
    // Compact ~96px circular brass-ring lens.
    expect((loupe as HTMLElement).style.width).toBe('96px');
    expect((loupe as HTMLElement).style.height).toBe('96px');
    expect((loupe as HTMLElement).className).toMatch('rounded-full');
    fireEvent.pointerUp(tl, { pointerId: 1 });
    expect(container.querySelector('[data-loupe]')).toBeNull();
  });

  it('loupe appears on midpoint grab and hides on cancel', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    mockAdjustRect(container);
    const midTop = document.querySelector('[data-crop-handle-mid="top"]') as HTMLElement;
    fireEvent.pointerDown(midTop, { clientX: 50, clientY: 10, pointerId: 1, buttons: 1 });
    expect(container.querySelector('[data-loupe]')).not.toBeNull();
    expect(container.querySelector('[data-loupe-crosshair]')).not.toBeNull();
    fireEvent.pointerCancel(midTop);
    expect(container.querySelector('[data-loupe]')).toBeNull();
  });

  it('loupe uses the calm 1.6x zoom with a 96px lens', () => {
    expect(LOUPE_ZOOM).toBe(1.6);
    expect(LOUPE_SIZE).toBe(96);
  });

  it('loupe source rect centers exactly on the active corner (1.6x zoom)', () => {
    // Interior corner: rect center == corner, size == lens/zoom.
    const r = loupeSourceRect(50, 40, 100, 100);
    expect(r.sw).toBeCloseTo(LOUPE_SIZE / LOUPE_ZOOM, 10);
    expect(r.sh).toBeCloseTo(LOUPE_SIZE / LOUPE_ZOOM, 10);
    expect(r.sx + r.sw / 2).toBeCloseTo(50, 10);
    expect(r.sy + r.sh / 2).toBeCloseTo(40, 10);
    // Edge corner: clamped into the photo, still covering the corner pixel.
    const edge = loupeSourceRect(0, 0, 100, 100);
    expect(edge.sx).toBe(0);
    expect(edge.sy).toBe(0);
    expect(edge.sw).toBeCloseTo(LOUPE_SIZE / LOUPE_ZOOM, 10);
  });

  it('loupe parks above-left of the point and stays inside the hero frame', () => {
    const pos = loupePosition(200, 200, 400, 400);
    expect(pos.left).toBe(200 - LOUPE_SIZE - 16);
    expect(pos.top).toBe(200 - LOUPE_SIZE - 16);
    expect(pos.left + LOUPE_SIZE).toBeLessThanOrEqual(400);
    expect(pos.top + LOUPE_SIZE).toBeLessThanOrEqual(400);
    // Near the top-left the lens clamps to the frame instead of escaping.
    const clamped = loupePosition(10, 10, 400, 400);
    expect(clamped.left).toBe(0);
    expect(clamped.top).toBe(0);
  });

  it('keyboard focus shows the loupe and blur hides it', () => {
    const { container } = render(<ScanicReview {...baseProps()} />);
    enterAdjust();
    mockAdjustRect(container);
    const tl = document.querySelector('[data-crop-handle="tl"]') as HTMLElement;
    fireEvent.focus(tl);
    expect(container.querySelector('[data-loupe]')).not.toBeNull();
    expect(container.querySelector('[data-loupe-crosshair]')).not.toBeNull();
    fireEvent.blur(tl);
    expect(container.querySelector('[data-loupe]')).toBeNull();
  });

  it('loupe degrades gracefully when canvas 2d is absent', () => {
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const original = proto['getContext'];
    proto['getContext'] = () => null;
    try {
      const { container } = render(<ScanicReview {...baseProps()} />);
      enterAdjust();
      mockAdjustRect(container);
      const tl = document.querySelector('[data-crop-handle="tl"]') as HTMLElement;
      expect(() =>
        fireEvent.pointerDown(tl, { clientX: 10, clientY: 10, pointerId: 1, buttons: 1 }),
      ).not.toThrow();
      // Lens frame + crosshair still render; no pixels required.
      expect(container.querySelector('[data-loupe]')).not.toBeNull();
      expect(container.querySelector('[data-loupe-crosshair]')).not.toBeNull();
      expect(() => fireEvent.pointerUp(tl, { pointerId: 1 })).not.toThrow();
      expect(container.querySelector('[data-loupe]')).toBeNull();
    } finally {
      proto['getContext'] = original;
    }
  });
});
