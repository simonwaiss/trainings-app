import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startSync } from './sync/manager';
import { App } from './ui/App';
import './styles.css';

// Bittet den Browser, die lokale Kopie nicht bei Platzmangel zu löschen.
void navigator.storage?.persist?.();
void startSync();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
