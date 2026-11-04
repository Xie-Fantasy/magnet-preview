import type { PreviewResult } from '../domain/preview';

export interface CachePolicy {
  schemaVersion: 1;
  ttlMs: number | null;
  capBytes: number | null;
}

export const defaultCachePolicy: CachePolicy = {
  schemaVersion: 1,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  capBytes: 512 * 1024 * 1024,
};

export interface CacheStats {
  previewCount: number;
  screenshotCount: number;
  usedBytes: number;
}

export interface PreviewCache {
  get(infoHash: string): Promise<PreviewResult | null>;
  put(result: PreviewResult): Promise<boolean>;
  getAsset(key: string): Promise<Blob | null>;
  putAsset(key: string, blob: Blob): Promise<boolean>;
  getPolicy(): Promise<CachePolicy>;
  setPolicy(policy: CachePolicy): Promise<void>;
  stats(): Promise<CacheStats>;
  clearDisposable(): Promise<void>;
}
