/**
 * ScanicReview tests: single-canvas result view, adjust-only quad overlay
 * with 8 handles (4 corners + 4 rigid-edge midpoints), adjust-mode
 * drag/keyboard editing, Apply/Re-detect emissions, Reset gating,
 * use-original verdict chip, and the reactive result image.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScanicReview from './ScanicReview';
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
    onLooksGood: vi.fn(),
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
    // No warp at all: skeleton + caption, still no photo canvas.
    rerender(<ScanicReview {...baseProps({ corners: null, warpedUrl: null })} />);
    const result2 = container.querySelector('[data-crop-result]');
    expect(result2?.querySelectorAll('img').length).toBe(0);
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
    const { container } = render(<ScanicReview {...props} />);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'warped.jpg',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use original' }));
    expect(props.onUseOriginal).toHaveBeenCalledTimes(1);
    const result = container.querySelector('[data-crop-result]');
    expect(result?.querySelectorAll('img').length).toBe(1);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'photo.jpg',
    );
    expect(screen.getByText('Original photo — unprocessed')).toBeTruthy();
    expect(result?.querySelector('polygon')).toBeNull();
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

  it('wires the verdict buttons to their callbacks', () => {
    const props = baseProps();
    render(<ScanicReview {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use original' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(props.onLooksGood).toHaveBeenCalledTimes(1);
    expect(props.onUseOriginal).toHaveBeenCalledTimes(1);
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });
});
