import type { PreviewResult } from '../domain/preview';

export interface FavoriteRecord {
  schemaVersion: 1;
  infoHash: string;
  magnet: string;
  snapshot: PreviewResult | null;
  assetIds: string[];
  missingImageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FavoriteStore {
  save(magnet: string, snapshot?: PreviewResult): Promise<FavoriteRecord>;
  get(infoHash: string): Promise<FavoriteRecord | null>;
  list(): Promise<FavoriteRecord[]>;
  remove(infoHash: string): Promise<void>;
  getAsset(infoHash: string, imageId: string): Promise<Blob | null>;
}

export class FavoriteSaveFailure extends Error {
  constructor(readonly reason: 'quota' | 'failed') {
    super('Favorite save failed');
  }
}
