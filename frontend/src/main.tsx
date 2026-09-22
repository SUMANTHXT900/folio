import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import './index.css';
import StudioApp from './studio/StudioApp';

/**
 * Production entry: the Folio experience backed by the Folio
 * engine. This bundle contains the app only — no developer tooling
 * is imported here, so production builds cannot ship it.
 */
function getRoot(): HTMLElement {
  const root = document.getElementById('root');
  if (root === null) {
    throw new Error('missing #root element');
  }
  return root;
}

createRoot(getRoot()).render(
  <StrictMode>
    <StudioApp />
  </StrictMode>,
);
