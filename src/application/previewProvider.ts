import type { PreviewResult } from '../domain/preview';

export interface PreviewProvider {
  fetchPreview(infoHash: string, signal: AbortSignal): Promise<PreviewResult>;
}
