import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { markBoot } from './lib/bootTimings';
import App from './App';
import './index.css';

markBoot('boot');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
