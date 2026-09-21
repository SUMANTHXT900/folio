import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import './index.css';
import StudioApp from './studio/StudioApp';

/**
 * Production entry: the PDF Studio experience backed by the Folio
 * engine. This bundle contains Studio only — the Developer Testbench
 * lives in top-level `testbench/` with its own dev server and is never
 * imported here, so production builds cannot ship testbench code.
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
