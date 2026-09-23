/**
 * Page Manager grid for Images → PDF.
 *
 * GUARANTEED reorder mechanism: ← / → move buttons on every card
 * (touch-friendly, keyboard-accessible, E2E-testable). Drag-and-drop is
 * PROGRESSIVE ENHANCEMENT only: lightweight HTML5 dragging for desktop
 * pointers — deliberately not a perfect grid-drag system (framer-motion
 * Reorder is single-axis and fights wrapping grids; see the feature
 * plan). Touch users get buttons, which are more reliable than drag.
 */
import { memo, useState } from 'react';
import { formatBytes } from '../components/ui';
import type { ImagePage } from './imagePages';

interface PageGridProps {
  pages: ImagePage[];
  onMove: (id: string, dir: -1 | 1) => void;
  onMoveTo: (id: string, index: number) => void;
  onRemove: (id: string) => void;
  onRotate: (id: string) => void;
}

const controlBtn =
  'flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-sm text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-900 disabled:opacity-25 dark:text-ink-300 dark:hover:bg-ink-700 dark:hover:text-paper-100';

const PageCard = memo(function PageCard({
  page,
  position,
  isFirst,
  isLast,
  dragging,
  dropTarget,
  onMove,
  onDropTo,
  onDragStartCard,
  onDragEndCard,
  onDragOverCard,
  onRemove,
  onRotate,
}: {
  page: ImagePage;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onMove: (dir: -1 | 1) => void;
  onDropTo: (index: number) => void;
  onDragStartCard: () => void;
  onDragEndCard: () => void;
  onDragOverCard: () => void;
  onRemove: () => void;
  onRotate: () => void;
}) {
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox requires data to start a drag.
        e.dataTransfer.setData('text/plain', page.id);
        onDragStartCard();
      }}
      onDragEnd={onDragEndCard}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOverCard();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropTo(position);
      }}
      aria-label={`Page ${position + 1}: ${page.name}`}
      className={`flex flex-col overflow-hidden rounded-2xl border bg-paper-50 transition-shadow dark:bg-ink-800/60 ${
        dropTarget
          ? 'border-brass-400 shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brass-400)_30%,transparent)]'
          : 'border-paper-300 dark:border-ink-700'
      } ${dragging ? 'opacity-50' : ''}`}
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-paper-200/60 dark:bg-ink-900/60">
        {page.previewUrl ? (
          <img
            src={page.previewUrl}
            alt={`Page ${position + 1} preview: ${page.name}`}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="max-h-full max-w-full object-contain transition-transform duration-200"
            style={{ transform: `rotate(${page.rotationDeg}deg)` }}
          />
        ) : (
          <div className="h-full w-full animate-pulse" />
        )}
        <span className="absolute left-2 top-2 rounded-full bg-ink-900/80 px-2 py-0.5 font-mono text-xs text-paper-50 tabular-nums dark:bg-paper-100/90 dark:text-ink-900">
          {position + 1}
        </span>
        <span
          className="absolute right-2 top-2 rounded-full bg-ink-900/70 px-2 py-0.5 text-[11px] text-paper-50 dark:bg-paper-100/85 dark:text-ink-900"
          title={page.source === 'camera' ? 'Captured with camera' : 'Uploaded from files'}
        >
          {page.source === 'camera' ? '📷' : '📁'}
        </span>
        {page.rotationDeg !== 0 && (
          <span className="absolute bottom-2 right-2 rounded-full bg-brass-500/90 px-2 py-0.5 font-mono text-[11px] text-white">
            {page.rotationDeg}°
          </span>
        )}
      </div>
      <div className="min-w-0 px-2 pt-1.5">
        <p className="truncate text-xs font-medium text-ink-900 dark:text-paper-100">{page.name}</p>
        <p className="font-mono text-[11px] text-ink-400 dark:text-ink-300">
          {formatBytes(page.size)}
        </p>
      </div>
      {/* Guaranteed reorder controls: move buttons work on every device. */}
      <div className="flex items-center justify-between px-1 pb-1">
        <div className="flex">
          <button
            onClick={() => onMove(-1)}
            disabled={isFirst}
            className={controlBtn}
            aria-label={`Move ${page.name} earlier`}
            title="Move earlier"
          >
            ←
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={isLast}
            className={controlBtn}
            aria-label={`Move ${page.name} later`}
            title="Move later"
          >
            →
          </button>
        </div>
        <div className="flex">
          <button
            onClick={onRotate}
            className={controlBtn}
            aria-label={`Rotate ${page.name} 90 degrees clockwise`}
            title="Rotate 90° clockwise"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.75 1 6.4 2.6L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          <button
            onClick={onRemove}
            className={
              controlBtn + ' hover:!bg-red-50 hover:!text-red-500 dark:hover:!bg-red-950/40'
            }
            aria-label={`Remove ${page.name}`}
            title="Remove page"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </li>
  );
});

export function PageGrid({ pages, onMove, onMoveTo, onRemove, onRotate }: PageGridProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  return (
    <ul
      className="grid list-none grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      aria-label="Pages in PDF order"
    >
      {pages.map((page, i) => (
        <PageCard
          key={page.id}
          page={page}
          position={i}
          isFirst={i === 0}
          isLast={i === pages.length - 1}
          dragging={dragId === page.id}
          dropTarget={dropIndex === i && dragId !== page.id}
          onMove={(dir) => onMove(page.id, dir)}
          onDropTo={(index) => {
            const from = dragId;
            setDragId(null);
            setDropIndex(null);
            if (from !== null && from !== page.id) onMoveTo(from, index);
          }}
          onDragStartCard={() => {
            setDragId(page.id);
            setDropIndex(i);
          }}
          onDragEndCard={() => {
            setDragId(null);
            setDropIndex(null);
          }}
          onDragOverCard={() => {
            if (dragId !== null && dragId !== page.id) setDropIndex(i);
          }}
          onRemove={() => onRemove(page.id)}
          onRotate={() => onRotate(page.id)}
        />
      ))}
    </ul>
  );
}
