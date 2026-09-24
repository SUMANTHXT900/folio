/**
 * Scan original-retention store tests: lifetime follows the accepted
 * page (remove/clear), never the camera session.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetScansForTests,
  clearScans,
  originalOf,
  releaseScan,
  retainOriginal,
} from './scanStore';

afterEach(() => {
  __resetScansForTests();
});

describe('scanStore', () => {
  it('retains and returns the original per page id', () => {
    const file = new File(['x'], 'scan-001.jpg', { type: 'image/jpeg' });
    retainOriginal('img-1', file, 'scan-001.jpg');
    expect(originalOf('img-1')?.original).toBe(file);
    expect(originalOf('img-1')?.name).toBe('scan-001.jpg');
    expect(originalOf('img-2')).toBeUndefined();
  });

  it('releases one entry on page removal and all on clear', () => {
    retainOriginal('a', new File(['a'], 'a.jpg'), 'a.jpg');
    retainOriginal('b', new File(['b'], 'b.jpg'), 'b.jpg');
    releaseScan('a');
    expect(originalOf('a')).toBeUndefined();
    expect(originalOf('b')).toBeDefined();
    clearScans();
    expect(originalOf('b')).toBeUndefined();
  });
});
