import type { NormalizedMagnet } from './magnet';

export interface PreviewFile {
  path: string;
  bytes?: number;
}
export interface PreviewImage {
  id: string;
  sourceUrl?: string;
  cachedAssetKey?: string;
  timeSeconds?: number;
  bytes?: number;
  mimeType?: string;
}
export interface PreviewResult {
  infoHash: string;
  magnet: string;
  name?: string;
  totalBytes?: number;
  fileCount?: number;
  files?: PreviewFile[];
  screenshots: PreviewImage[];
  providerId: string;
  fetchedAt: number;
}
export type PreviewPhase =
  | 'idle'
  | 'scanning'
  | 'queued'
  | 'requesting'
  | 'success'
  | 'partial_success'
  | 'unavailable';
export interface TechnicalDetails {
  category: string;
  retryAfterMs?: number;
}
export interface PreviewState {
  phase: PreviewPhase;
  technicalDetails?: TechnicalDetails;
}
export interface PreviewManager {
  getPreview(magnet: NormalizedMagnet): Promise<PreviewResult>;
  getMany(magnets: readonly NormalizedMagnet[]): Promise<PreviewResult[]>;
  getState(infoHash: string): PreviewState;
}
