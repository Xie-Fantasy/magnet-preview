import { loadPreferences } from './store';
import { resolveTheme } from './theme';

export function applyInitialTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(
    loadPreferences().theme,
    matchMedia('(prefers-color-scheme: dark)').matches,
  );
}
