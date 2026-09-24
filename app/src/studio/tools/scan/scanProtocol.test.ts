/**
 * Scan protocol tests: versioning, framing guards, and the
 * success/fallback/error distinction the UI branches on.
 */
import { describe, expect, it } from 'vitest';
import { SCAN_PROTOCOL_VERSION, parseScanMessage } from './scanProtocol';

describe('scanProtocol', () => {
  it('pins the protocol version', () => {
    expect(SCAN_PROTOCOL_VERSION).toBe(1);
  });

  it('accepts well-formed messages', () => {
    expect(parseScanMessage({ protocol: 1, kind: 'ready' })).toEqual({
      protocol: 1,
      kind: 'ready',
    });
    expect(
      parseScanMessage({ protocol: 1, kind: 'status', jobId: 'scan-1', phase: 'processing' }),
    ).not.toBeNull();
    expect(
      parseScanMessage({ protocol: 1, kind: 'result', jobId: 'scan-1', resultJson: '{}' }),
    ).not.toBeNull();
    expect(
      parseScanMessage({ protocol: 1, kind: 'fatal', jobId: null, message: 'boom' }),
    ).not.toBeNull();
  });

  it('rejects malformed framing without throwing', () => {
    expect(parseScanMessage(null)).toBeNull();
    expect(parseScanMessage('ready')).toBeNull();
    expect(parseScanMessage({ protocol: 999, kind: 'ready' })).toBeNull();
    expect(parseScanMessage({ protocol: 1, kind: 'nope' })).toBeNull();
    expect(parseScanMessage({ protocol: 1, kind: 'result', jobId: 'scan-1' })).toBeNull();
    expect(parseScanMessage({ protocol: 1, kind: 'fatal', jobId: null })).toBeNull();
  });
});
