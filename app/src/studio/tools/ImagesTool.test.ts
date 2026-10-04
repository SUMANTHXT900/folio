/**
 * Build-loop staging tests (`stageImagePages`): per-page progress counts
 * in collection order, byte-identical staging, and ordering preservation
 * for the sharded build downstream. Sharding semantics themselves are
 * owned by `imageSharding.test.ts` and are untouched here.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImagesTool, { preStageShardEstimate, stageImagePages } from './ImagesTool';
import { createPage } from './imagePages';
import type { ImageRenderer } from './imagePrepare';

function stubRenderer(): ImageRenderer {
  return {
    rotateToBytes: vi.fn(async () => new Uint8Array([1, 2])),
  };
}

function upload(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

describe('stageImagePages', () => {
  it('stages in collection order with per-page progress counts', async () => {
    const pages = [
      createPage({ id: 'a', source: 'upload', file: upload('a.jpg', [1]), name: 'a.jpg' }),
      createPage({ id: 'b', source: 'upload', file: upload('b.jpg', [2, 2]), name: 'b.jpg' }),
      createPage({ id: 'c', source: 'upload', file: upload('c.jpg', [3, 3, 3]), name: 'c.jpg' }),
    ];
    const progress: Array<[number, number]> = [];
    const staged = await stageImagePages(pages, stubRenderer(), (completed, total) =>
      progress.push([completed, total]),
    );
    // Order preserved (shard/merge contract depends on it).
    expect(staged.map((s) => s.name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    // Unrotated pages pass through byte-identical (zero-copy direct path).
    expect(Array.from(staged[0].bytes)).toEqual([1]);
    expect(Array.from(staged[2].bytes)).toEqual([3, 3, 3]);
    // Import-queue-style per-page counts.
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('routes rotated pages through the renderer without reordering', async () => {
    const rotated = {
      ...createPage({ id: 'r', source: 'upload', file: upload('r.jpg', [9]), name: 'r.jpg' }),
      rotationDeg: 90 as const,
    };
    const plain = createPage({
      id: 'p',
      source: 'upload',
      file: upload('p.jpg', [7]),
      name: 'p.jpg',
    });
    const renderer = stubRenderer();
    const staged = await stageImagePages([rotated, plain], renderer);
    expect(staged.map((s) => s.name)).toEqual(['r.jpg', 'p.jpg']);
    expect(Array.from(staged[0].bytes)).toEqual([1, 2]);
    expect(Array.from(staged[1].bytes)).toEqual([7]);
    expect(renderer.rotateToBytes).toHaveBeenCalledTimes(1);
  });

  it('reports progress even with no subscribers changing semantics', async () => {
    const pages = [
      createPage({ id: 'a', source: 'upload', file: upload('a.jpg', [1]), name: 'a.jpg' }),
    ];
    const staged = await stageImagePages(pages, stubRenderer());
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe('a.jpg');
  });
});

describe('preStageShardEstimate', () => {
  it('sums pre-stage file bytes for the policy input', () => {
    const pages = [
      createPage({ id: 'a', source: 'upload', file: upload('a.jpg', [1, 2]), name: 'a.jpg' }),
      createPage({
        id: 'b',
        source: 'upload',
        file: upload('b.jpg', [3, 4, 5]),
        name: 'b.jpg',
      }),
    ];
    const estimate = preStageShardEstimate(pages);
    expect(estimate.totalBytes).toBe(5);
    expect(estimate.totalPixels).toBe(0);
  });

  it('keeps small batches on the single-worker path', () => {
    const pages = Array.from({ length: 3 }, (_, i) =>
      createPage({
        id: `p${i}`,
        source: 'upload',
        file: upload(`p${i}.jpg`, [i + 1]),
        name: `p${i}.jpg`,
      }),
    );
    // Below the shard threshold the page-count gate decides first:
    // pre-stage and post-stage evaluations agree — behavior identical.
    expect(preStageShardEstimate(pages).shards).toBe(1);
  });
});

describe('camera entry (scanic reintegration)', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens the scanner from the entry-card Scan tile', () => {
    render(createElement(ImagesTool));
    const open = document.querySelector('[data-scan-open]');
    expect(open).not.toBeNull();
    fireEvent.click(open as HTMLElement);
    expect(document.querySelector('[data-scanner-root]')).not.toBeNull();
  });

  it('closes the scanner without touching the empty collection', () => {
    render(createElement(ImagesTool));
    fireEvent.click(document.querySelector('[data-scan-open]') as HTMLElement);
    expect(document.querySelector('[data-scanner-root]')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Close scanner'));
    expect(document.querySelector('[data-scanner-root]')).toBeNull();
    // Still the empty entry card — no pages were added.
    expect(screen.getByText(/decode one at a time/)).toBeTruthy();
  });
});
