import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Straight from its file, not the package's index: the phone gets the remote, not the editor and its styles.
import { PhoneApp } from '@warraq/ui/src/remote/phone/PhoneApp';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from remote.html');

createRoot(root).render(
  <StrictMode>
    <PhoneApp />
  </StrictMode>,
);
