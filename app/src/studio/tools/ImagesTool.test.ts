/**
 * Build-loop staging tests (`stageImagePages`): per-page progress counts
 * in collection order, byte-identical staging, and ordering preservation
 * for the sharded build downstream. Sharding semantics themselves are
 * owned by `imageSharding.test.ts` and are untouched here.
 */
import { describe, expect, it, vi } from 'vitest';
import { stageImagePages } from './ImagesTool';
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
      createPage({ id: 'b', source: 'camera', file: upload('b.jpg', [2, 2]), name: 'b.jpg' }),
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
