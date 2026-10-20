/**
 * `ContinueCard` tests: the post-completion fork (use-in-tool vs download).
 *
 * The transfer service (`adoptOutputsAsDocs` / `setPendingTransfer` in
 * `services/folio.ts`) is mocked at the module boundary so the handoff
 * order (adopt → transfer → hash navigate) and failure paths are asserted
 * without touching real binaries. Download naming is asserted through the
 * real `downloadNaming` policy (sourceName-chained, never generic).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioOutput } from '../services/folio';
import ContinueCard, {
  ContinueCard as NamedContinueCard,
  continueRowDelay,
  continueStepTransition,
} from './ContinueCard';
import { continueStaggerDelay } from './ui';

const mocks = vi.hoisted(() => ({
  adoptOutputsAsDocs: vi.fn(),
  setPendingTransfer: vi.fn(),
}));

vi.mock('../services/folio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/folio')>();
  return {
    ...actual,
    adoptOutputsAsDocs: mocks.adoptOutputsAsDocs,
    setPendingTransfer: mocks.setPendingTransfer,
  };
});

function seam(): {
  adoptOutputsAsDocs: ReturnType<typeof vi.fn>;
  setPendingTransfer: ReturnType<typeof vi.fn>;
} {
  return mocks;
}

function makeOutput(overrides: Partial<StudioOutput> = {}): StudioOutput {
  return {
    name: 'output.pdf',
    bytes: new Uint8Array([1, 2, 3]),
    byteLength: 3,
    pageCount: 2,
    ...overrides,
  };
}

beforeEach(() => {
  let counter = 0;
  URL.createObjectURL = vi.fn(() => {
    counter += 1;
    return `blob:continue-${counter}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  mocks.adoptOutputsAsDocs.mockReset();
  mocks.setPendingTransfer.mockReset();
  mocks.adoptOutputsAsDocs.mockResolvedValue([
    { id: 'studio-9', name: 'continued.pdf', sizeBytes: 3, pageCount: 2 },
  ]);
  window.location.hash = '#/';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ContinueCard summary', () => {
  it('shows engine duration, page count, and output size from props', () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
        durationMs={380}
      />,
    );
    expect(screen.getByText(/2 pages/)).toBeTruthy();
    expect(screen.getByText(/3 B/)).toBeTruthy();
    expect(screen.getByText(/Completed in 380ms/)).toBeTruthy();
  });

  it('summarizes multi-output with per-part page counts', () => {
    render(
      <ContinueCard
        outputs={[makeOutput({ pageCount: 2 }), makeOutput({ pageCount: 5 })]}
        sourceName="report.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
        durationMs={1240}
      />,
    );
    expect(screen.getByText(/2 files/)).toBeTruthy();
    expect(screen.getByText(/Part 1 — 2 pages/)).toBeTruthy();
    expect(screen.getByText(/Part 2 — 5 pages/)).toBeTruthy();
    expect(screen.getByText(/Completed in 1.24s/)).toBeTruthy();
  });

  it('focuses the heading on mount for keyboard users', () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /what's next/i }));
  });
});

describe('ContinueCard download branch', () => {
  it('renders DownloadCard with the sourceName-chained smart name (single)', () => {
    render(
      <ContinueCard
        outputs={[makeOutput({ name: '' })]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /download/i, expanded: false }));
    // merge + single input → `<base>-merged.pdf`.
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe('a-merged.pdf');
  });

  it('renders MultiDownloadCard rows with split-part names (multi)', () => {
    render(
      <ContinueCard
        outputs={[makeOutput({ name: '' }), makeOutput({ name: '', pageCount: 4 })]}
        sourceName="report.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^download$/i }));
    expect((screen.getByLabelText('File name part 1') as HTMLInputElement).value).toBe(
      'report-p1-1.pdf',
    );
    expect((screen.getByLabelText('File name part 2') as HTMLInputElement).value).toBe(
      'report-p2-2.pdf',
    );
  });
});

describe('ContinueCard tool picker', () => {
  it('offers the v1 allowlist and never offers Images as a target', () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    for (const name of ['Merge', 'Split', 'Rearrange', 'Rotate', 'Metadata']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /images/i })).toBeNull();
  });

  it('still offers the allowlist when produced by Images', () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="scan-001.jpg"
        producedBy="images"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    expect(screen.getByRole('button', { name: /merge/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^images$/i })).toBeNull();
  });

  it('adopts, transfers, then navigates on target pick', async () => {
    const out = makeOutput();
    render(
      <ContinueCard
        outputs={[out]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    fireEvent.click(screen.getByRole('button', { name: /rotate/i }));

    await waitFor(() => expect(seam().adoptOutputsAsDocs).toHaveBeenCalledTimes(1));
    expect(seam().adoptOutputsAsDocs).toHaveBeenCalledWith([out], 'a.pdf');
    expect(seam().setPendingTransfer).toHaveBeenCalledWith(
      [{ id: 'studio-9', name: 'continued.pdf', sizeBytes: 3, pageCount: 2 }],
      'a.pdf',
      'merge',
    );
    expect(window.location.hash).toBe('#/rotate');
  });

  it('announces the adopting status while the seam is pending', () => {
    mocks.adoptOutputsAsDocs.mockReturnValue(new Promise(() => {}));
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    fireEvent.click(screen.getByRole('button', { name: /rotate/i }));
    expect(screen.getByText(/Preparing Rotate/)).toBeTruthy();
  });

  it('shows adopt failures honestly with message and code', async () => {
    mocks.adoptOutputsAsDocs.mockRejectedValue(
      Object.assign(new Error('Those page numbers are not valid'), {
        code: 'INVALID_PAGE_RANGE',
      }),
    );
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    fireEvent.click(screen.getByRole('button', { name: /split/i }));
    await waitFor(() => expect(screen.getByText('Those page numbers are not valid')).toBeTruthy());
    expect(screen.getByText('INVALID_PAGE_RANGE')).toBeTruthy();
    // No navigation on failure.
    expect(window.location.hash).toBe('#/');
  });
});

describe('ContinueCard split multi-output', () => {
  function renderSplit() {
    render(
      <ContinueCard
        outputs={[
          makeOutput({ name: 'report-p1-2.pdf' }),
          makeOutput({ name: 'report-p3-5.pdf', pageCount: 3 }),
        ]}
        sourceName="report.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
  }

  it('offers per-part continue plus continue-with-all-as-merge', () => {
    renderSplit();
    expect(
      screen.getByRole('button', { name: /continue with all 2 as merge inputs/i }),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /continue with this part/i })).toHaveLength(2);
  });

  it('restricts an all-parts subset to Merge with a visible reason', () => {
    renderSplit();
    const split = screen.getByRole('button', { name: 'Continue 2 files in Split' });
    expect((split as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Multiple files can continue into Merge only/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Continue 2 files in Merge' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('adopts all parts when Merge is picked with the all subset', async () => {
    const outputs = [
      makeOutput({ name: 'report-p1-2.pdf' }),
      makeOutput({ name: 'report-p3-5.pdf', pageCount: 3 }),
    ];
    render(
      <ContinueCard
        outputs={outputs}
        sourceName="report.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue 2 files in Merge' }));
    await waitFor(() => expect(seam().adoptOutputsAsDocs).toHaveBeenCalledTimes(1));
    expect(seam().adoptOutputsAsDocs).toHaveBeenCalledWith(outputs, 'report.pdf');
    expect(window.location.hash).toBe('#/merge');
  });

  it('adopts only the picked part and unlocks every target', async () => {
    const partTwo = makeOutput({ name: 'report-p3-5.pdf', pageCount: 3 });
    render(
      <ContinueCard
        outputs={[makeOutput({ name: 'report-p1-2.pdf' }), partTwo]}
        sourceName="report.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    fireEvent.click(
      screen.getByRole('button', { name: /continue with this part \(report-p3-5\.pdf\)/i }),
    );
    expect(
      (screen.getByRole('button', { name: 'Continue Part 2 in Split' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Continue Part 2 in Split' }));
    await waitFor(() => expect(seam().adoptOutputsAsDocs).toHaveBeenCalledTimes(1));
    expect(seam().adoptOutputsAsDocs).toHaveBeenCalledWith([partTwo], 'report.pdf');
    expect(window.location.hash).toBe('#/split');
  });

  it('resets the picked subset when a new completion arrives', () => {
    const first = [
      makeOutput({ name: 'a-p1.pdf' }),
      makeOutput({ name: 'a-p2.pdf', pageCount: 3 }),
    ];
    const { rerender } = render(
      <ContinueCard
        outputs={first}
        sourceName="a.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue with this part \(a-p2\.pdf\)/i }));
    expect(
      (screen.getByRole('button', { name: 'Continue Part 2 in Split' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // A re-run produces new outputs: the stale part pick must not survive.
    rerender(
      <ContinueCard
        outputs={[makeOutput({ name: 'b-p1.pdf' }), makeOutput({ name: 'b-p2.pdf' })]}
        sourceName="b.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
      />,
    );
    expect(
      screen
        .getByRole('button', { name: /continue with all 2 as merge inputs/i })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      (screen.getByRole('button', { name: 'Continue 2 files in Split' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe('ContinueCard back to edit', () => {
  it('calls onBackToEdit and renders nothing tool-specific without outputs', () => {
    const onBackToEdit = vi.fn();
    render(
      <ContinueCard
        outputs={[]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={onBackToEdit}
      />,
    );
    expect(screen.getByText(/no output to continue with/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /back to edit/i }));
    expect(onBackToEdit).toHaveBeenCalledTimes(1);
  });

  it('calls onBackToEdit from the full card', () => {
    const onBackToEdit = vi.fn();
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={onBackToEdit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /back to edit/i }));
    expect(onBackToEdit).toHaveBeenCalledTimes(1);
  });
});

describe('ContinueCard contract (polish lane)', () => {
  it('exposes the same component as default and named export', () => {
    // ImagesTool imports { ContinueCard }; every other tool uses default.
    expect(NamedContinueCard).toBe(ContinueCard);
  });

  it('uses the exact G motion tokens for step transitions', () => {
    expect(continueStepTransition(false)).toEqual({
      duration: 0.26,
      ease: [0.22, 1, 0.36, 1],
    });
  });

  it('collapses step transitions to an instant crossfade under reduced motion', () => {
    expect(continueStepTransition(true).duration).toBe(0.01);
  });

  it('caps picker-row stagger at 0.16s and removes it under reduced motion', () => {
    expect(continueStaggerDelay(0)).toBe(0);
    expect(continueStaggerDelay(1)).toBeCloseTo(0.04, 5);
    expect(continueStaggerDelay(4)).toBeCloseTo(0.16, 5);
    expect(continueStaggerDelay(10)).toBeCloseTo(0.16, 5);
    expect(continueRowDelay(10, false)).toBeCloseTo(0.16, 5);
    expect(continueRowDelay(10, true)).toBe(0);
    expect(continueRowDelay(0, true)).toBe(0);
  });

  it('does not stack "-merged" when continuing from a merged file', () => {
    render(
      <ContinueCard
        outputs={[makeOutput({ name: '' })]}
        sourceName="a-b-merged.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^download$/i }));
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe('a-b-merged.pdf');
  });

  it('still chains other producers exactly (no over-stripping)', () => {
    render(
      <ContinueCard
        outputs={[makeOutput({ name: '' })]}
        sourceName="doc-rotated.pdf"
        producedBy="rotate"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^download$/i }));
    expect((screen.getByLabelText('File name') as HTMLInputElement).value).toBe(
      'doc-rotated-rotated.pdf',
    );
  });
});

describe('ContinueCard step UX (polish lane)', () => {
  it('labels single-output targets "Continue in <Tool>"', () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    expect(screen.getByRole('button', { name: 'Continue in Rotate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^images$/i })).toBeNull();
  });

  it('refocuses the heading when a branch opens', () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    // Move focus away so the step change (not the mount) is what refocuses.
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { name: /what's next/i }));
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /what's next/i }));
  });

  it('collapses on Esc and returns focus to the opening trigger', async () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    const trigger = screen.getByRole('button', { name: /use in another tool/i });
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Continue in Rotate' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    // The mode="wait" exit transition keeps the leaving branch mounted
    // briefly; collapse completes once it unmounts.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Continue in Rotate' })).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('ignores non-Escape keys while a branch is open', () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /use in another tool/i }));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Continue in Rotate' })).toBeTruthy();
  });
});

describe('ContinueCard download rows (stable keys + resync)', () => {
  it('resyncs row names when a re-run reuses output sizes', () => {
    // Both completions carry byteLength 3: the old `${i}-${byteLength}` key
    // collided here and froze the stale edit. Stable `part-N` keys plus the
    // PartRow resync effect must show the new suggestion instead.
    const { rerender } = render(
      <ContinueCard
        outputs={[
          makeOutput({ name: 'a-p1.pdf', byteLength: 3 }),
          makeOutput({ name: 'a-p2.pdf', byteLength: 3 }),
        ]}
        sourceName="a.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^download$/i }));
    fireEvent.change(screen.getByLabelText('File name part 1'), {
      target: { value: 'my-custom' },
    });
    expect((screen.getByLabelText('File name part 1') as HTMLInputElement).value).toBe('my-custom');

    rerender(
      <ContinueCard
        outputs={[
          makeOutput({ name: 'b-p1.pdf', byteLength: 3 }),
          makeOutput({ name: 'b-p2.pdf', byteLength: 3 }),
        ]}
        sourceName="b.pdf"
        producedBy="split"
        onBackToEdit={() => {}}
      />,
    );
    expect((screen.getByLabelText('File name part 1') as HTMLInputElement).value).toBe('b-p1.pdf');
    expect((screen.getByLabelText('File name part 2') as HTMLInputElement).value).toBe('b-p2.pdf');
  });

  it('gives focus targets a visible Folio ring instead of outline-none', () => {
    render(
      <ContinueCard
        outputs={[makeOutput()]}
        sourceName="a.pdf"
        producedBy="merge"
        onBackToEdit={() => {}}
      />,
    );
    const heading = screen.getByRole('heading', { name: /what's next/i });
    expect(heading.className).toMatch(/focus-visible:ring-2/);
    expect(heading.className).toMatch(/ring-brass-400\/40/);
    expect(heading.className).not.toMatch(/focus:outline-none/);
  });
});
