import { sitePattern } from '../siteControl';

export const PAGE_TOOL_VISIBILITY_KEY = 'magnetPreview.pageToolVisibility.v1';
export type HideScope = 'visit' | 'site' | 'global';
export interface PageToolVisibility {
  schemaVersion: 1;
  globalDisabled: boolean;
  disabledSites: string[];
}
export function parsePageToolVisibility(value: unknown): PageToolVisibility {
  const input = value as Partial<PageToolVisibility> | null;
  return {
    schemaVersion: 1,
    globalDisabled: input?.schemaVersion === 1 && input.globalDisabled === true,
    disabledSites:
      input?.schemaVersion === 1 && Array.isArray(input.disabledSites)
        ? [
            ...new Set(
              input.disabledSites.filter(
                (site): site is string =>
                  typeof site === 'string' && sitePattern(site) === site,
              ),
            ),
          ].sort()
        : [],
  };
}
export async function getPageToolVisibility(): Promise<PageToolVisibility> {
  const stored = await chrome.storage.local.get(PAGE_TOOL_VISIBILITY_KEY);
  return parsePageToolVisibility(stored[PAGE_TOOL_VISIBILITY_KEY]);
}
export function pageToolsDisabled(
  value: PageToolVisibility,
  url: string,
): boolean {
  const site = sitePattern(url);
  return (
    value.globalDisabled ||
    (site !== null && value.disabledSites.includes(site))
  );
}
