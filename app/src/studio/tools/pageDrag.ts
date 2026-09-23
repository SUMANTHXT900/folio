/**
 * Drag-and-drop result mapping for the page grid.
 *
 * Pure logic: given the current id order plus the dnd-kit `active` and
 * `over` ids, computes the `movePageTo` call — or `null` when the drop
 * changes nothing. The grid component owns sensors/overlay/indicator;
 * this module owns the deterministic part, covered by unit tests.
 * No bytes, no DOM, no URLs involved.
 */

export interface DragMove {
  id: string;
  index: number;
}

/**
 * Maps a drop onto the target index. Dropping on a card means "take the
 * dragged page's place": `movePageTo` removes then inserts, which yields
 * exactly the arrayMove semantics dnd-kit documents for sortable lists.
 */
export function dragTargetMove(
  ids: string[],
  activeId: string,
  overId: string | null,
): DragMove | null {
  if (overId === null || activeId === overId) return null;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return null;
  return { id: activeId, index: to };
}
