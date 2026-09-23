/**
 * Page Manager grid for Images → PDF.
 *
 * PRIMARY reorder: drag-and-drop via dnd-kit (wrapping-grid-friendly
 * `rectSortingStrategy`). Pointer/mouse, touch (long-press), and keyboard
 * dragging all run through the same sortable model. The grip handle is
 * the ONLY drag activator — card action buttons can never start a drag.
 *
 * GUARANTEED fallback: ← / → move buttons on every card (always work,
 * E2E-asserted). The pure drop→index mapping lives in `pageDrag.ts`;
 * `imagePages.ts` ordering logic is reused unchanged.
 */
import { memo, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { formatBytes } from '../components/ui';
import { dragTargetMove } from './pageDrag';
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

const GripIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="9" cy="6" r="1.6" />
    <circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" />
    <circle cx="15" cy="18" r="1.6" />
  </svg>
);

const PageCard = memo(function PageCard({
  page,
  position,
  isFirst,
  isLast,
  indicator,
  onMove,
  onRemove,
  onRotate,
}: {
  page: ImagePage;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  /** Insertion indicator edge while another card is dragged over this one. */
  indicator: 'before' | 'after' | null;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onRotate: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.id,
  });

  return (
    <li
      ref={setNodeRef}
      aria-label={`Page ${position + 1}: ${page.name}`}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`relative flex flex-col overflow-hidden rounded-2xl border bg-paper-50 dark:bg-ink-800/60 ${
        indicator !== null ? 'border-brass-400' : 'border-paper-300 dark:border-ink-700'
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      {/* Insertion indicator: exactly where the page will land. */}
      {indicator !== null && (
        <span
          aria-hidden
          data-drop-indicator={indicator}
          className={`absolute inset-y-2 z-10 w-1 rounded-full bg-brass-500 ${
            indicator === 'before' ? '-left-1' : '-right-1'
          }`}
        />
      )}
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
      <div className="flex items-center justify-between px-1 pb-1">
        <div className="flex items-center">
          {/* Drag handle — the only sortable activator. `touch-action: none`
              keeps long-press drags from becoming page scrolls; the rest of
              the card scrolls normally. */}
          <button
            {...attributes}
            {...listeners}
            style={{ touchAction: 'none' }}
            className={controlBtn + ' cursor-grab active:cursor-grabbing'}
            aria-label={`Drag ${page.name} to reorder`}
            title="Drag to reorder"
          >
            {GripIcon}
          </button>
          {/* Guaranteed fallback: move buttons always work. */}
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
  const ids = useMemo(() => pages.map((p) => p.id), [pages]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // Long-press to lift on touch; taps and scrolls pass through untouched.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeIndex = activeId === null ? -1 : ids.indexOf(activeId);
  const overIndex = overId === null ? -1 : ids.indexOf(overId);
  const activePage = activeId === null ? null : (pages.find((p) => p.id === activeId) ?? null);

  const reset = () => {
    setActiveId(null);
    setOverId(null);
  };

  const handleStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };
  const handleOver = (event: DragOverEvent) => {
    setOverId(event.over === null ? null : String(event.over.id));
  };
  const handleEnd = (event: DragEndEvent) => {
    const move = dragTargetMove(
      ids,
      String(event.active.id),
      event.over === null ? null : String(event.over.id),
    );
    reset();
    if (move !== null) onMoveTo(move.id, move.index);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleStart}
      onDragOver={handleOver}
      onDragEnd={handleEnd}
      onDragCancel={reset}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <ul
          className="grid list-none grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          aria-label="Pages in PDF order"
        >
          {pages.map((page, i) => {
            const isOver = overId === page.id && activeId !== null && activeId !== page.id;
            return (
              <PageCard
                key={page.id}
                page={page}
                position={i}
                isFirst={i === 0}
                isLast={i === pages.length - 1}
                indicator={
                  !isOver || activeIndex < 0 || overIndex < 0
                    ? null
                    : overIndex > activeIndex
                      ? 'after'
                      : 'before'
                }
                onMove={(dir) => onMove(page.id, dir)}
                onRemove={() => onRemove(page.id)}
                onRotate={() => onRotate(page.id)}
              />
            );
          })}
        </ul>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activePage ? (
          <div
            data-drag-overlay
            className="flex w-32 flex-col overflow-hidden rounded-2xl border border-brass-400 bg-paper-50 opacity-95 shadow-xl dark:bg-ink-800"
          >
            <div className="flex aspect-square items-center justify-center overflow-hidden bg-paper-200/60 dark:bg-ink-900/60">
              {activePage.previewUrl && (
                <img
                  src={activePage.previewUrl}
                  alt=""
                  draggable={false}
                  className="max-h-full max-w-full object-contain"
                />
              )}
            </div>
            <p className="truncate px-2 py-1 text-xs font-medium text-ink-900 dark:text-paper-100">
              {activePage.name}
            </p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
