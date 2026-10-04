/**
 * ScanicReview tests: detect-overlay quad tracks the `corners` prop,
 * adjust-mode drag/keyboard editing, Apply/Re-detect emissions, Reset
 * gating, and the reactive result-strip image.
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

describe('ScanicReview', () => {
  it('draws the ML-found quad over the original photo and tracks prop corners', () => {
    const { container, rerender } = render(<ScanicReview {...baseProps()} />);
    const overlay = container.querySelector('[data-detect-overlay]');
    expect(overlay).not.toBeNull();
    const polygon = overlay?.querySelector('polygon');
    expect(polygon?.getAttribute('points')).toBe('10,10 90,10 90,90 10,90');

    const next = detectedCorners();
    next.topLeft = { x: 20, y: 25 };
    rerender(<ScanicReview {...baseProps({ corners: next })} />);
    expect(overlay?.querySelector('polygon')?.getAttribute('points')).toBe(
      '20,25 90,10 90,90 10,90',
    );
  });

  it('shows an honest no-detection caption when corners are null', () => {
    const { container } = render(<ScanicReview {...baseProps({ corners: null })} />);
    const overlay = container.querySelector('[data-detect-overlay]');
    expect(overlay?.querySelector('polygon')).toBeNull();
    expect(screen.getByText('Auto-detect found no page — adjust to crop manually.')).toBeTruthy();
  });

  it('shows a Preparing skeleton while detecting', () => {
    const { container } = render(<ScanicReview {...baseProps({ detecting: true })} />);
    expect(container.querySelector('[data-detect-overlay]')?.textContent).toContain('Preparing…');
  });

  it('renders the reactive result strip from warpedUrl with fallback to photoUrl', () => {
    const { container, rerender } = render(<ScanicReview {...baseProps()} />);
    const img = container.querySelector('[data-crop-result-img]');
    expect(img?.getAttribute('src')).toBe('warped.jpg');
    rerender(<ScanicReview {...baseProps({ warpedUrl: 'warped-2.jpg' })} />);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'warped-2.jpg',
    );
    rerender(<ScanicReview {...baseProps({ warpedUrl: null })} />);
    expect(container.querySelector('[data-crop-result-img]')?.getAttribute('src')).toBe(
      'photo.jpg',
    );
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

  it('Apply emits the dragged quad', () => {
    const props = baseProps();
    const { container } = render(<ScanicReview {...props} />);
    enterAdjust();
    const overlay = container.querySelector('[data-detect-overlay]') as HTMLElement;
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 }) as DOMRect;
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
