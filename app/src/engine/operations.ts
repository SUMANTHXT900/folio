/**
 * Operation registry: makes engine operations discoverable by the UI.
 *
 * Each entry carries display metadata plus the form kind the testbench
 * renders for it. Adding a future operation (e.g. `pdf.encrypt`)
 * means: one entry here, one `OperationId` literal in types, one form
 * case in the UI, and one branch in the adapter — nothing else changes.
 */

import type { OperationId } from '../types/engine';

export type OptionFormKind =
  | 'inspect'
  | 'page-list'
  | 'page-list-angle'
  | 'order-list'
  | 'split-parts'
  | 'images-to-pdf'
  | 'metadata'
  | 'none';

export interface OperationMeta {
  id: OperationId;
  title: string;
  description: string;
  /** 'single' = one PDF file, 'multi' = ordered file list. */
  inputs: 'single' | 'multi';
  form: OptionFormKind;
  supportsCancellation: boolean;
  producesDocuments: boolean;
  benchmarkable: boolean;
}

export const OPERATIONS: OperationMeta[] = [
  {
    id: 'pdf.inspect',
    title: 'PDF Inspect',
    description: 'Read-only document properties and optional per-page geometry.',
    inputs: 'single',
    form: 'inspect',
    supportsCancellation: true,
    producesDocuments: false,
    benchmarkable: true,
  },
  {
    id: 'pdf.extract_pages',
    title: 'PDF Extract Pages',
    description: 'Copy selected pages into a new document, in listed order.',
    inputs: 'single',
    form: 'page-list',
    supportsCancellation: true,
    producesDocuments: true,
    benchmarkable: true,
  },
  {
    id: 'pdf.split',
    title: 'PDF Split',
    description: 'Divide one document into independent parts (one line per part).',
    inputs: 'single',
    form: 'split-parts',
    supportsCancellation: true,
    producesDocuments: true,
    benchmarkable: true,
  },
  {
    id: 'pdf.reorder',
    title: 'PDF Reorder',
    description: 'Reorder every page; the list must be an exact permutation.',
    inputs: 'single',
    form: 'order-list',
    supportsCancellation: true,
    producesDocuments: true,
    benchmarkable: true,
  },
  {
    id: 'pdf.delete_pages',
    title: 'PDF Delete Pages',
    description: 'Remove listed pages; survivors keep source order.',
    inputs: 'single',
    form: 'page-list',
    supportsCancellation: true,
    producesDocuments: true,
    benchmarkable: true,
  },
  {
    id: 'pdf.rotate',
    title: 'PDF Rotate',
    description: 'Rotate listed pages by a relative quarter-turn angle.',
    inputs: 'single',
    form: 'page-list-angle',
    supportsCancellation: true,
    producesDocuments: true,
    benchmarkable: true,
  },
  {
    id: 'pdf.merge',
    title: 'PDF Merge',
    description: 'Concatenate documents in listed order into one PDF.',
    inputs: 'multi',
    form: 'none',
    supportsCancellation: true,
    producesDocuments: true,
    benchmarkable: true,
  },
  {
    id: 'pdf.images_to_pdf',
    title: 'Images to PDF',
    description: 'Build one PDF from images (JPEG/PNG), one page per image, in listed order.',
    inputs: 'multi',
    form: 'images-to-pdf',
    supportsCancellation: true,
    producesDocuments: true,
    benchmarkable: true,
  },
  {
    id: 'pdf.read_metadata',
    title: 'PDF Read Metadata',
    description: 'Read typed document metadata (title, author, dates) without modifying anything.',
    inputs: 'single',
    form: 'none',
    supportsCancellation: true,
    producesDocuments: false,
    benchmarkable: true,
  },
  {
    id: 'pdf.set_metadata',
    title: 'PDF Set Metadata',
    description: 'Patch metadata fields (set/clear/leave unchanged) and write a new PDF.',
    inputs: 'single',
    form: 'metadata',
    supportsCancellation: true,
    producesDocuments: true,
    benchmarkable: true,
  },
];

export function getOperation(id: OperationId): OperationMeta {
  const found = OPERATIONS.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`unknown operation: ${id}`);
  }
  return found;
}
