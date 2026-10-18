import { useSyncExternalStore } from 'react';
import { installPrompt, type InstallSnapshot } from './installPrompt';

export function usePwaInstall(): InstallSnapshot {
  return useSyncExternalStore(installPrompt.subscribe, installPrompt.snapshot);
}

export { installPrompt };
