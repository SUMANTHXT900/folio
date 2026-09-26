/**
 * Scan protocol tests: versioning, framing guards, and the
 * success/fallback/error distinction the UI branches on.
 */
import { describe, expect, it } from 'vitest';
import { SCAN_PROTOCOL_VERSION, parseScanMessage } from './scanProtocol';

describe('scanProtocol', () => {
  it('pins the protocol version', () => {
    // v2 added the `detectOnly` process flag + `detected` results.
    expect(SCAN_PROTOCOL_VERSION).toBe(2);
  });

  it('accepts well-formed messages', () => {
    expect(parseScanMessage({ protocol: 2, kind: 'ready' })).toEqual({
      protocol: 2,
      kind: 'ready',
    });
    expect(
      parseScanMessage({ protocol: 2, kind: 'status', jobId: 'scan-1', phase: 'processing' }),
    ).not.toBeNull();
    expect(
      parseScanMessage({ protocol: 2, kind: 'result', jobId: 'scan-1', resultJson: '{}' }),
    ).not.toBeNull();
    expect(
      parseScanMessage({ protocol: 2, kind: 'fatal', jobId: null, message: 'boom' }),
    ).not.toBeNull();
  });

  it('rejects malformed framing without throwing', () => {
    expect(parseScanMessage(null)).toBeNull();
    expect(parseScanMessage('ready')).toBeNull();
    expect(parseScanMessage({ protocol: 999, kind: 'ready' })).toBeNull();
    expect(parseScanMessage({ protocol: 1, kind: 'ready' })).toBeNull();
    expect(parseScanMessage({ protocol: 2, kind: 'nope' })).toBeNull();
    expect(parseScanMessage({ protocol: 2, kind: 'result', jobId: 'scan-1' })).toBeNull();
    expect(parseScanMessage({ protocol: 2, kind: 'fatal', jobId: null })).toBeNull();
  });
});
