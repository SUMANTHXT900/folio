import { describe, expect, it } from 'vitest';
import { OPERATIONS, getOperation } from './operations';

describe('operation registry', () => {
  it('registers all ten current operations with unique IDs', () => {
    const ids = OPERATIONS.map((entry) => entry.id);
    expect(ids).toEqual([
      'pdf.inspect',
      'pdf.extract_pages',
      'pdf.split',
      'pdf.reorder',
      'pdf.delete_pages',
      'pdf.rotate',
      'pdf.merge',
      'pdf.images_to_pdf',
      'pdf.read_metadata',
      'pdf.set_metadata',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the metadata the testbench needs', () => {
    for (const entry of OPERATIONS) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(['single', 'multi']).toContain(entry.inputs);
      expect(entry.supportsCancellation).toBe(true);
      expect(entry.benchmarkable).toBe(true);
    }
    expect(getOperation('pdf.merge').inputs).toBe('multi');
    expect(getOperation('pdf.images_to_pdf').inputs).toBe('multi');
    expect(getOperation('pdf.images_to_pdf').form).toBe('images-to-pdf');
    expect(getOperation('pdf.read_metadata').form).toBe('none');
    expect(getOperation('pdf.set_metadata').form).toBe('metadata');
    expect(OPERATIONS.filter((entry) => entry.inputs === 'single').length).toBe(8);
    expect(OPERATIONS.filter((entry) => entry.producesDocuments).length).toBe(8);
  });

  it('rejects unknown operation IDs', () => {
    expect(() => getOperation('pdf.nope' as 'pdf.inspect')).toThrowError(/unknown operation/);
  });
});
