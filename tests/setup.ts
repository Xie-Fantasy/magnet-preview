import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  const values = new Map<string, string>();
  const storage = {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal('localStorage', storage);
  document.documentElement.dataset.theme = 'light';
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal('chrome', {
    i18n: { getUILanguage: () => 'en', getMessage: () => '' },
    runtime: { getURL: (path: string) => path, sendMessage: vi.fn() },
    tabs: { create: vi.fn(), query: vi.fn(async () => [{ id: 1 }]) },
  });
});
