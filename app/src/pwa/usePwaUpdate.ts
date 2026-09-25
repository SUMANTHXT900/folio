import { useSyncExternalStore } from 'react';
import { updateManager, type UpdateSnapshot } from './updateManager';

export function usePwaUpdate(): UpdateSnapshot {
  return useSyncExternalStore(updateManager.subscribe, updateManager.snapshot);
}

export { updateManager };
