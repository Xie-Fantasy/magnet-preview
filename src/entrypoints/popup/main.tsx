import React from 'react';
import { createRoot } from 'react-dom/client';
import { Popup, ScreenshotCacheContext, FavoriteStoreContext } from './Popup';
import { IndexedDbPreviewCache } from '../../infrastructure/storage/indexedDbPreviewCache';
import { IndexedDbFavorites } from '../../infrastructure/storage/indexedDbFavorites';
import { BackgroundFavoriteStore } from '../../infrastructure/storage/backgroundFavoriteStore';
import '../../shared/style.css';
import './popup.css';
import { applyInitialTheme } from '../../shared/preferences/applyTheme';

applyInitialTheme();
const cache = new IndexedDbPreviewCache();
const favorites = new BackgroundFavoriteStore(new IndexedDbFavorites(cache));
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FavoriteStoreContext.Provider value={favorites}>
      <ScreenshotCacheContext.Provider value={cache}>
        <Popup />
      </ScreenshotCacheContext.Provider>
    </FavoriteStoreContext.Provider>
  </React.StrictMode>,
);
