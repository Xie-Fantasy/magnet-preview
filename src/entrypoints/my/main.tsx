import React from 'react';
import { createRoot } from 'react-dom/client';
import { MyPage } from './MyPage';
import { IndexedDbPreviewCache } from '../../infrastructure/storage/indexedDbPreviewCache';
import { IndexedDbFavorites } from '../../infrastructure/storage/indexedDbFavorites';
import '../../shared/style.css';
import { applyInitialTheme } from '../../shared/preferences/applyTheme';

applyInitialTheme();
const cache = new IndexedDbPreviewCache();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MyPage cache={cache} favorites={new IndexedDbFavorites(cache)} />
  </React.StrictMode>,
);
