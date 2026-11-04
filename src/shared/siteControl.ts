export function sitePattern(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

export function siteScriptId(pattern: string): string {
  return `magnet-preview-site-${btoa(pattern).replace(/[^a-zA-Z0-9]/g, '_')}`;
}
