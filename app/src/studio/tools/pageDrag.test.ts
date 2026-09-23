/**
 * Drag-result mapping tests. The sensor/overlay/indicator behavior is
 * exercised in the browser E2E (keyboard-drag reorder); the index
 * mapping itself is deterministic and covered here.
 */
import { describe, expect, it } from 'vitest';
import { dragTargetMove } from './pageDrag';

describe('dragTargetMove', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('maps a drop on another card to its index', () => {
    expect(dragTargetMove(ids, 'a', 'c')).toEqual({ id: 'a', index: 2 });
    expect(dragTargetMove(ids, 'd', 'a')).toEqual({ id: 'd', index: 0 });
  });

  it('returns null for no-op drops', () => {
    expect(dragTargetMove(ids, 'b', 'b')).toBeNull();
    expect(dragTargetMove(ids, 'b', null)).toBeNull();
  });

  it('returns null for unknown ids', () => {
    expect(dragTargetMove(ids, 'zzz', 'a')).toBeNull();
    expect(dragTargetMove(ids, 'a', 'zzz')).toBeNull();
  });
});
